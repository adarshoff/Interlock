// Resets Interlock into a known state for recording, then keeps the console and attack pages running.
//   cd demo && npm run reset            (add -- --no-seed to skip the 4,000 history rows)
// Ctrl+C stops the console and the page server. The agent client (e.g. Claude Desktop) launches Interlock itself.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// node:sqlite announces itself as experimental; keep the checklist readable.
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w); });

const ROOT = resolve(import.meta.dirname, "..");
const SERVER = join(ROOT, "server");
const CONSOLE = join(ROOT, "console");
const PAGES = join(ROOT, "attack-suite", "pages");
const PAGES_PORT = 8790;
const CONSOLE_PORT = 5173;
const MANDATE = {
  instruction_text: "Book a hotel near the conference venue, under $200 a night.",
  amount_cap: 200,
  cumulative_cap: 600,
  hours: 24,
};
const SEED = !process.argv.includes("--no-seed");

/* ---------- reporting ---------- */

const color = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32), red = color(31), yellow = color(33), bold = color(1), dim = color(2);
type Level = "ok" | "warn" | "fail" | "info";
const results: Array<{ level: Level; label: string; note?: string }> = [];
const mark: Record<Level, string> = { ok: green("✓"), warn: yellow("!"), fail: red("✗"), info: dim("·") };
function report(level: Level, label: string, note?: string) {
  results.push({ level, label, note });
  console.log(`  ${mark[level]} ${level === "fail" ? red(label) : label}${note ? dim(`  ${note}`) : ""}`);
}
const section = (title: string) => console.log(`\n${bold(title)}`);

/* ---------- helpers ---------- */

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const portInUse = (port: number) =>
  fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function status(url: string, init: RequestInit = {}): Promise<number> {
  try { return (await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })).status; } catch { return 0; }
}
const tsx = join(SERVER, "node_modules", "tsx", "dist", "cli.mjs");

/* ---------- 1. prerequisites ---------- */

console.log(bold("\nInterlock demo reset"));
section("Prerequisites");
const [major] = process.versions.node.split(".").map(Number);
report(major >= 22 ? "ok" : "fail", `Node ${process.versions.node}`, major >= 22 ? undefined : "node:sqlite needs a recent Node; tested on 24");
for (const [dir, name] of [[SERVER, "server"], [CONSOLE, "console"]] as const)
  report(existsSync(join(dir, "node_modules")) ? "ok" : "fail", `${name} dependencies installed`,
    existsSync(join(dir, "node_modules")) ? undefined : `run: cd ${name} && npm install`);
const envFile = join(SERVER, ".env");
const env = readEnv(envFile);
report(existsSync(envFile) ? "ok" : "fail", "server/.env present", existsSync(envFile) ? undefined : "copy server/.env.example to server/.env");
const apiPort = Number(env.INTERLOCK_API_PORT || 8787);
const holdMs = Number(env.HOLD_TIMEOUT_MS || 120_000);

/* ---------- 2. nothing already running ---------- */

section("Clean slate");
const interlockRunning = await portInUse(apiPort);
report(interlockRunning ? "fail" : "ok", interlockRunning ? `Interlock is already running (port ${apiPort} answers)` : `No Interlock running on :${apiPort}`,
  interlockRunning ? "quit Claude Desktop / stop the agent first: the database is in use, and the next Interlock would start without its console API" : undefined);
let portsTaken = false;
for (const [port, what] of [[CONSOLE_PORT, "console"], [PAGES_PORT, "attack page server"]] as const)
  if (await portInUse(port)) {
    portsTaken = true;
    report("fail", `Port ${port} is taken`, `stop whatever is using it (an earlier reset still running?); the ${what} needs it`);
  }

/* ---------- 3. fresh database ---------- */

section("Database");
const dbPath = resolve(SERVER, env.INTERLOCK_DB || "./interlock.db");
let dbReady = false;
if (interlockRunning || portsTaken) {
  report("fail", "Database not reset", interlockRunning ? "Interlock holds it open" : "something from an earlier run is still up");
} else {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync);
  try {
    if (files.length) {
      const backups = join(SERVER, "db-backups");
      mkdirSync(backups, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      for (const f of files) renameSync(f, join(backups, f.slice(SERVER.length + 1).replace("interlock.db", `interlock-${stamp}.db`)));
      report("ok", "Previous database moved aside", `server/db-backups/interlock-${stamp}.db`);
    } else report("info", "No previous database");

    if (SEED) {
      const seeded = spawnSync(process.execPath, [tsx, "src/seed.ts"], { cwd: SERVER, encoding: "utf8" });
      report(seeded.status === 0 ? "ok" : "fail", seeded.status === 0 ? "Seeded 4,000 history payments" : "Seeding failed",
        seeded.status === 0 ? "for the Payments grid, under their own (now revoked) mandate" : (seeded.stderr || "").trim().split("\n").pop());
    }

    process.env.DOTENV_CONFIG_PATH = envFile;
    process.env.INTERLOCK_DB = dbPath;
    const { db } = await import("../server/src/db.js");
    db.prepare(`UPDATE mandates SET status='revoked' WHERE status='active'`).run();
    const id = `mdt_demo_${Date.now().toString(36)}`;
    db.prepare(
      `INSERT INTO mandates (id,user_id,instruction_text,amount_cap,cumulative_cap,categories,expires_at,status,created_at)
       VALUES (?,?,?,?,?,?,?,'active',?)`
    ).run(id, "user_1", MANDATE.instruction_text, MANDATE.amount_cap, MANDATE.cumulative_cap, null,
          Date.now() + MANDATE.hours * 3_600_000, Date.now());
    db.close();
    report("ok", `Active mandate: $${MANDATE.amount_cap} per payment, $${MANDATE.cumulative_cap} total, ${MANDATE.hours}h`, `"${MANDATE.instruction_text}"`);
    dbReady = true;
  } catch (e) {
    report("fail", "Database reset failed", e instanceof Error ? e.message : String(e));
  }
}

/* ---------- 4. PayPal ---------- */

section("PayPal sandbox token");
const token = env.PAYPAL_ACCESS_TOKEN;
if (!token) {
  report("fail", "PAYPAL_ACCESS_TOKEN is empty", "see the README: Get a PayPal sandbox access token");
} else {
  const pp = "https://api-m.sandbox.paypal.com";
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const who = await status(`${pp}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, auth);
  if (who !== 200) {
    report("fail", who === 401 ? "Token expired or invalid (401)" : `Token check failed (HTTP ${who || "no response"})`,
      "generate a new one; tokens last about nine hours");
  } else {
    report("ok", "Token valid");
    const end = new Date(), start = new Date(Date.now() - 7 * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 19) + "Z";
    const features: Array<[string, string, number, string]> = [
      ["Orders (create_order, pay_order)", `${pp}/v2/checkout/orders/0000000000000000X`, 404, "fail"],
      ["Invoicing (create_invoice, send_invoice)", `${pp}/v2/invoicing/invoices?page_size=1`, 200, "warn"],
      ["Transaction search (list_transactions)", `${pp}/v1/reporting/transactions?start_date=${iso(start)}&end_date=${iso(end)}&page_size=1`, 200, "warn"],
    ];
    for (const [label, url, allowed, severity] of features) {
      const s = await status(url, auth);
      if (s === allowed) report("ok", label);
      else report(severity as Level, `${label}: HTTP ${s}`,
        s === 403 ? "not enabled on this app: enable it under Features, then generate a NEW token" : "unexpected response");
    }
  }
}

/* ---------- 5. AI gates ---------- */

section("AI gates");
const provider = (env.AI_PROVIDER || "anthropic").toLowerCase();
const key = provider === "groq" ? env.GROQ_API_KEY : env.ANTHROPIC_API_KEY;
const model = provider === "groq" ? env.GROQ_MODEL || "openai/gpt-oss-120b" : env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
if (!key) {
  report("warn", `MOCK mode: no ${provider === "groq" ? "GROQ_API_KEY" : "ANTHROPIC_API_KEY"}`, "intent and injection checks fall back to heuristics");
} else if (provider === "groq") {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    const ids: string[] = r.ok ? ((await r.json()) as any).data.map((m: any) => m.id) : [];
    if (!r.ok) report("fail", `Groq key rejected (HTTP ${r.status})`, "a configured key that fails holds every payment");
    else report(ids.includes(model) ? "ok" : "fail", `Groq: ${model}`, ids.includes(model) ? "agent and gates share this key's rate limit" : "model not available to this key");
  } catch (e) { report("fail", "Groq unreachable", String(e)); }
} else {
  const s = await status("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
  });
  report(s === 200 ? "ok" : "fail", s === 200 ? `Anthropic: ${model}` : `Anthropic check failed (HTTP ${s})`,
    s === 200 ? undefined : "no credit or bad key: every payment will hold");
}

/* ---------- 6. upstream package and the agent's config ---------- */

section("Agent side");
// Run without --tools so it installs (if needed), prints its usage error and exits at once.
const [npxCmd, npxArgs] = process.platform === "win32" ? ["cmd", ["/c", "npx", "-y", "@paypal/mcp"]] : ["npx", ["-y", "@paypal/mcp"]];
const warm = spawnSync(npxCmd, npxArgs, { encoding: "utf8", timeout: 180_000, env: { ...process.env, PAYPAL_ACCESS_TOKEN: "" } });
const warmed = /PayPal|tools|Access Token/i.test(`${warm.stdout}${warm.stderr}`);
report(warmed ? "ok" : "warn", warmed ? "@paypal/mcp cached" : "Could not warm the @paypal/mcp cache",
  warmed ? "first launch will not stall on an npx install" : "the first launch may take a minute");

const desktopConfig = process.platform === "win32" ? join(process.env.APPDATA ?? "", "Claude", "claude_desktop_config.json")
  : process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
  : join(homedir(), ".config", "Claude", "claude_desktop_config.json");
try {
  const servers = JSON.parse(readFileSync(desktopConfig, "utf8")).mcpServers ?? {};
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  const entry = Object.entries<any>(servers).find(([, s]) => (s.args ?? []).some((a: string) => norm(a).includes(norm(SERVER))));
  if (!entry) report("warn", "Claude Desktop is not pointed at Interlock", `no mcpServers entry in ${desktopConfig} references ${SERVER}`);
  else if ((entry[1].args ?? []).includes("dev")) report("fail", `Claude Desktop entry "${entry[0]}" runs "dev"`, "use start: tsx watch holds stdin and breaks stdio");
  else report("ok", `Claude Desktop entry "${entry[0]}" launches Interlock`, "fully quit and reopen Claude Desktop so it starts fresh");
} catch {
  report("info", "No Claude Desktop config found", "fine if you are recording with another MCP client");
}

/* ---------- 7. attack pages and console ---------- */

// Starting servers on top of an earlier run would report its console as ours.
const blocked = interlockRunning || portsTaken;
section("Running");
if (blocked) report("fail", "Console and attack pages not started", "fix the clean-slate problems first");
const children: ChildProcess[] = [];
const pages = readdirSync(PAGES).filter((f) => f.endsWith(".html")).sort();
const pageServer = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "/").split("?")[0].slice(1));
  if (!pages.includes(name)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(PAGES, name)));
});
let pagesUp = false;
let vite: ChildProcess | null = null;
if (!blocked) {
  pagesUp = await new Promise<boolean>((ok) => {
    pageServer.once("error", () => ok(false));
    pageServer.listen(PAGES_PORT, () => ok(true));
  });
  report(pagesUp ? "ok" : "fail", pagesUp ? `Attack pages on http://localhost:${PAGES_PORT}/` : `Attack pages could not start on :${PAGES_PORT}`,
    pagesUp ? `${pages.length} pages` : undefined);

  vite = spawn(process.execPath, [join(CONSOLE, "node_modules", "vite", "bin", "vite.js"), "--port", String(CONSOLE_PORT), "--strictPort"], {
    cwd: CONSOLE, env: { ...process.env, VITE_HOLD_TIMEOUT_MS: String(holdMs) }, stdio: "ignore",
  });
  children.push(vite);
  let consoleUp = false;
  for (let i = 0; i < 60 && !consoleUp && vite.exitCode === null; i++) {
    await sleep(500);
    consoleUp = (await status(`http://localhost:${CONSOLE_PORT}/`)) === 200;
  }
  report(consoleUp ? "ok" : "fail", consoleUp ? `Console on http://localhost:${CONSOLE_PORT}/` : "Console did not start",
    consoleUp ? `countdown set to ${holdMs / 1000}s to match HOLD_TIMEOUT_MS` : undefined);
  report("info", "Interlock itself starts when the agent connects", "its console API on :" + apiPort + " appears then");
}

/* ---------- summary ---------- */

const fails = results.filter((r) => r.level === "fail");
const warns = results.filter((r) => r.level === "warn");
const line = "=".repeat(64);
console.log("");
if (fails.length) {
  console.log(red(bold(line)));
  console.log(red(bold(`  NOT READY TO RECORD: ${fails.length} problem${fails.length > 1 ? "s" : ""}`)));
  for (const f of fails) console.log(red(`   ✗ ${f.label}`));
  console.log(red(bold(line)));
} else {
  console.log(green(bold(`  READY TO RECORD${warns.length ? `, with ${warns.length} warning${warns.length > 1 ? "s" : ""}` : ""}`)));
}
for (const w of warns) console.log(yellow(`   ! ${w.label}`));
if (pagesUp) {
  console.log(dim(`\n  Pages for fetch_page:`));
  for (const p of pages) console.log(dim(`    http://localhost:${PAGES_PORT}/${p}`));
}
if (blocked) process.exit(1);
console.log(dim(`\n  Ctrl+C stops the console and the page server.\n`));

/* ---------- stay up, and say when the agent connects ---------- */

const shutdown = () => {
  for (const c of children) c.kill();
  pageServer.close();
  process.exit(fails.length ? 1 : 0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
vite?.on("exit", (code) => { if (code) console.log(red(`  ✗ console exited (code ${code})`)); });

let connected = false;
setInterval(async () => {
  const up = (await status(`http://localhost:${apiPort}/api/policies`)) === 200;
  if (up !== connected) {
    connected = up;
    console.log(up ? green(`  ✓ ${new Date().toLocaleTimeString()} Interlock connected: the console is live`)
                   : yellow(`  ! ${new Date().toLocaleTimeString()} Interlock disconnected`));
  }
}, 2000);
if (!dbReady) console.log(red("  Database was not reset; fix the problems above and run again."));
