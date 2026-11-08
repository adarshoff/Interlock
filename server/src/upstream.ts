import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cfg, log } from "./config.js";

let client: Client | null = null;
let toolCache: any[] = [];

/** Interlock is an MCP client facing PayPal and an MCP server facing the agent. */
export async function connectUpstream(): Promise<Client> {
  if (client) return client;

  const transport = new StdioClientTransport({
    command: cfg.upstreamCommand,
    args: cfg.upstreamArgs,
    env: {
      ...(process.env as Record<string, string>),
      PAYPAL_ACCESS_TOKEN: cfg.paypalAccessToken,
      PAYPAL_ENVIRONMENT: cfg.paypalEnvironment,
    },
  });

  const c = new Client({ name: "interlock-proxy", version: "0.1.0" }, { capabilities: {} });
  await c.connect(transport);
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

export async function callUpstream(name: string, args: Record<string, unknown>) {
  const c = await connectUpstream();
  return c.callTool({ name, arguments: args });
}
