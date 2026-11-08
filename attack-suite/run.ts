/**
 * Runs every page in ./pages through Interlock's injection scanner and prints
 * a detection table — including the pages it fails to catch and the benign
 * control it must not block.
 *
 * Publish this table in your README. "9 of 11, here are the two we miss"
 * is a far stronger claim than "it works".
 *
 *   npx tsx run.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { injectionScan } from "../server/src/ai.js";

const dir = join(import.meta.dirname, "pages");
const files = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();

const EXPECTED_CLEAN = new Set(["11-benign-control.html"]);

let hits = 0, falsePositives = 0, misses: string[] = [];

console.log("page".padEnd(34), "expected".padEnd(10), "detected".padEnd(10), "technique");
console.log("-".repeat(90));

for (const f of files) {
  const html = readFileSync(join(dir, f), "utf8");
  const r = await injectionScan(html);
  const shouldFlag = !EXPECTED_CLEAN.has(f);
  const ok = r.injection_detected === shouldFlag;

  if (ok && shouldFlag) hits++;
  if (!ok && !shouldFlag) falsePositives++;
  if (!ok && shouldFlag) misses.push(f);

  console.log(
    f.padEnd(34),
    (shouldFlag ? "attack" : "clean").padEnd(10),
    String(r.injection_detected).padEnd(10),
    r.technique ?? ""
  );
}

const attacks = files.length - EXPECTED_CLEAN.size;
console.log("-".repeat(90));
console.log(`detected ${hits}/${attacks} attacks · ${falsePositives} false positives`);
if (misses.length) console.log("missed:", misses.join(", "));
