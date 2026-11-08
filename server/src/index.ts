import { startApi } from "./api.js";
import { startMcpServer } from "./mcp.js";
import { closeUpstream } from "./upstream.js";
import { log } from "./config.js";

/**
 * One process. The MCP proxy owns stdin/stdout; the console API owns a port.
 * Every log line goes to stderr — writing to stdout corrupts the JSON-RPC
 * stream and the agent disconnects without saying why.
 */
let shuttingDown = false;
async function shutdown(reason: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down: ${reason}`);
  await closeUpstream();
  process.exit(code);
}

// The agent closing our stdin is the only disconnect signal stdio gives us.
process.stdin.on("end", () => shutdown("agent closed stdin"));
process.stdin.on("close", () => shutdown("agent closed stdin"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startApi();
startMcpServer().catch((e) => {
  log("failed to start MCP proxy:", e);
  shutdown("startup failed", 1);
});
