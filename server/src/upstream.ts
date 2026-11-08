import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cfg, log } from "./config.js";

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let toolCache: any[] = [];

/** Interlock is an MCP client facing PayPal and an MCP server facing the agent. */
export async function connectUpstream(): Promise<Client> {
  if (client) return client;

  transport = new StdioClientTransport({
    command: cfg.upstreamCommand,
    args: cfg.upstreamArgs,
    env: {
      ...(process.env as Record<string, string>),
      PAYPAL_ACCESS_TOKEN: cfg.paypalAccessToken,
      PAYPAL_ENVIRONMENT: cfg.paypalEnvironment,
    },
  });

  const c = new Client({ name: "interlock-proxy", version: "0.1.0" }, { capabilities: {} });
  // A cold `npx -y` install of the upstream can outlast the SDK's 60s default.
  await c.connect(transport, { timeout: 180_000 });
  client = c;

  const listed = await c.listTools();
  toolCache = listed.tools;
  log(`upstream connected, ${toolCache.length} tools:`, toolCache.map((t) => t.name).join(", "));
  return c;
}

/** The agent sees PayPal's tools under their real names and schemas. */
export function upstreamTools() {
  return toolCache;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Ends the upstream gracefully (stdin EOF), then kills its whole process tree if it lingers. */
export async function closeUpstream() {
  const pid = transport?.pid ?? null;
  const closing = client?.close().catch(() => {});
  client = null;
  transport = null;
  await Promise.race([closing, new Promise((r) => setTimeout(r, 1500))]);
  // On Windows the child is cmd.exe wrapping npx; SIGTERM would orphan npx and the PayPal server.
  if (pid && isAlive(pid)) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
    } else {
      process.kill(pid, "SIGKILL");
    }
  }
}

export async function callUpstream(name: string, args: Record<string, unknown>) {
  const c = await connectUpstream();
  return c.callTool({ name, arguments: args });
}
