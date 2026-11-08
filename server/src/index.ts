import { startApi } from "./api.js";
import { startMcpServer } from "./mcp.js";
import { log } from "./config.js";

/**
 * One process. The MCP proxy owns stdin/stdout; the console API owns a port.
 * Every log line goes to stderr — writing to stdout corrupts the JSON-RPC
 * stream and the agent disconnects without saying why.
 */
startApi();
startMcpServer().catch((e) => {
  log("failed to start MCP proxy:", e);
  process.exit(1);
});
