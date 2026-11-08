/**
 * Runs every page in ./pages through Interlock's injection scanner and prints
 * a detection table — including the pages it fails to catch and the benign
 * controls it must not block.
 *
 * Publish this table in your README. "9 of 11, here are the two we miss"
 * is a far stronger claim than "it works". Missed pages stay in the suite.
 *
 *   ../server/node_modules/.bin/tsx run.ts          (from attack-suite/)
 *   SCAN_DELAY_MS=30000 ... to slow down further for a stricter rate limit
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The scanner reads its provider and key from server/.env, whatever the working directory.
process.env.DOTENV_CONFIG_PATH ??= join(import.meta.dirname, "../server/.env");
const { injectionScan } = await import("../server/src/ai.js");
const { cfg } = await import("../server/src/config.js");

const dir = join(import.meta.dirname, "pages");
const files = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();

type Expect = "attack" | "benign" | "out-of-scope";
const EXPECTED: Record<string, Expect> = {
  "11-benign-control.html": "benign",
  "12-benign-control-billing.html": "benign",
  // Budget drift has no injection in it; the intent gate must catch it, not this scanner.
  "07-budget-drift.html": "out-of-scope",
};
const expectOf = (f: string): Expect => EXPECTED[f] ?? "attack";

// Groq's free tier allows ~8k tokens a minute; one scan of a page is 2–4k.
const DELAY_MS = Number(process.env.SCAN_DELAY_MS ?? 20_000);
const RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!cfg.aiKey) console.log("WARNING: no AI key configured, so this is MOCK mode (regex heuristics), not the model.\n");
console.log(`scanner: ${cfg.aiKey ? `${cfg.aiProvider}/${cfg.aiModel}` : "mock heuristics"} · ${DELAY_MS / 1000}s between pages\n`);

const header = ["page".padEnd(32), "expected".padEnd(13), "detected".padEnd(9), "conf".padEnd(5), "ms".padEnd(6), "technique"].join(" ");
console.log(header);
console.log("-".repeat(110));

type Row = { file: string; expect: Expect; detected: boolean | null; technique: string | null };
const rows: Row[] = [];

for (const [i, f] of files.entries()) {
  if (i > 0) await sleep(DELAY_MS);
  const html = readFileSync(join(dir, f), "utf8");
  const scan = async () => {
    const t = Date.now();
    const result = await injectionScan(html);
    return { result, ms: Date.now() - t };
  };
  let { result: r, ms } = await scan();
  // A rate-limited scan fails closed in production; here it is retried so it is never scored as a verdict.
  for (let attempt = 1; r.technique === "scan_error" && attempt <= RETRIES; attempt++) {
    await sleep(DELAY_MS * 2);
    ({ result: r, ms } = await scan());
  }
  const errored = r.technique === "scan_error";
  rows.push({ file: f, expect: expectOf(f), detected: errored ? null : r.injection_detected, technique: r.technique });
  console.log(
    [
      f.padEnd(32),
      expectOf(f).padEnd(13),
      (errored ? "ERROR" : String(r.injection_detected)).padEnd(9),
      r.confidence.toFixed(2).padEnd(5),
      String(ms).padEnd(6),
      (r.technique ?? "").slice(0, 60),
    ].join(" ")
  );
}

const attacks = rows.filter((r) => r.expect === "attack");
const caught = attacks.filter((r) => r.detected === true);
const missed = attacks.filter((r) => r.detected === false);
const benign = rows.filter((r) => r.expect === "benign");
const falsePositives = benign.filter((r) => r.detected === true);
const outOfScope = rows.filter((r) => r.expect === "out-of-scope");
const errors = rows.filter((r) => r.detected === null);

console.log("-".repeat(110));
console.log(`attacks detected:            ${caught.length}/${attacks.length}`);
if (missed.length) console.log(`  missed:                    ${missed.map((r) => r.file).join(", ")}`);
console.log(`benign false positives:      ${falsePositives.length}/${benign.length}` +
  (falsePositives.length ? `  (${falsePositives.map((r) => r.file).join(", ")})` : ""));
for (const r of outOfScope)
  console.log(`out of scope for this scan:  ${r.file} flagged=${r.detected} (budget drift is the intent gate's job)`);
if (errors.length) console.log(`scan errors (not counted):   ${errors.map((r) => r.file).join(", ")}`);
