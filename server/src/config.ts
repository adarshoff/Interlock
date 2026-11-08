import "dotenv/config";

export const cfg = {
  apiPort: Number(process.env.INTERLOCK_API_PORT ?? 8787),
  dbPath: process.env.INTERLOCK_DB ?? "./interlock.db",
  holdTimeoutMs: Number(process.env.HOLD_TIMEOUT_MS ?? 120_000),

  upstreamCommand: process.env.UPSTREAM_COMMAND ?? "npx",
  upstreamArgs: (process.env.UPSTREAM_ARGS ?? "-y,@paypal/mcp,--tools=all").split(","),
  paypalAccessToken: process.env.PAYPAL_ACCESS_TOKEN ?? "",
  paypalEnvironment: process.env.PAYPAL_ENVIRONMENT ?? "SANDBOX",

  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  aiModel: process.env.AI_MODEL ?? "claude-sonnet-4-6",
};

/**
 * Tools that move money. Everything else is passed straight through with no
 * checks and no added latency. Keep this list explicit — never infer it.
 */
export const MONEY_MOVING_TOOLS = new Set([
  "create_order",
  "capture_order",
  "pay_order",
  "create_payout",
  "create_refund",
  "create_subscription",
  "create_invoice",
  "send_invoice",
]);

/**
 * stdout belongs to the MCP protocol. Every log line goes to stderr or the
 * JSON-RPC stream is corrupted and the agent silently disconnects.
 */
export const log = (...args: unknown[]) => console.error("[interlock]", ...args);
