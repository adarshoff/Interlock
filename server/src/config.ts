import "dotenv/config";

const AI_PROVIDERS = {
  anthropic: { keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL", defaultModel: "claude-sonnet-4-6" },
  groq: { keyVar: "GROQ_API_KEY", modelVar: "GROQ_MODEL", defaultModel: "openai/gpt-oss-120b" },
} as const;
export type AiProvider = keyof typeof AI_PROVIDERS;

const aiProvider = (process.env.AI_PROVIDER ?? "anthropic").trim().toLowerCase() as AiProvider;
if (!(aiProvider in AI_PROVIDERS))
  throw new Error(`AI_PROVIDER="${process.env.AI_PROVIDER}" is not supported. Use one of: ${Object.keys(AI_PROVIDERS).join(", ")}.`);
const provider = AI_PROVIDERS[aiProvider];

export const cfg = {
  apiPort: Number(process.env.INTERLOCK_API_PORT ?? 8787),
  dbPath: process.env.INTERLOCK_DB ?? "./interlock.db",
  holdTimeoutMs: Number(process.env.HOLD_TIMEOUT_MS ?? 120_000),

  upstreamCommand: process.env.UPSTREAM_COMMAND ?? "npx",
  upstreamArgs: (process.env.UPSTREAM_ARGS ?? "-y,@paypal/mcp,--tools=all").split(","),
  paypalAccessToken: process.env.PAYPAL_ACCESS_TOKEN ?? "",
  paypalEnvironment: process.env.PAYPAL_ENVIRONMENT ?? "SANDBOX",

  aiProvider,
  /** Empty means mock mode: heuristics only, no model calls. */
  aiKey: process.env[provider.keyVar] ?? "",
  aiKeyVar: provider.keyVar,
  aiModel: process.env[provider.modelVar] || provider.defaultModel,
};

/**
 * Tools that move money. Everything else is passed straight through with no
 * checks and no added latency. Keep this list explicit — never infer it.
 */
export const MONEY_MOVING_TOOLS = new Set([
  "create_order",
  "pay_order",
  "create_refund",
  "accept_dispute_claim",
  "create_subscription",
  "create_invoice",
  "send_invoice",
]);

/**
 * stdout belongs to the MCP protocol. Every log line goes to stderr or the
 * JSON-RPC stream is corrupted and the agent silently disconnects.
 */
export const log = (...args: unknown[]) => console.error("[interlock]", ...args);
