import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { nanoid } from "nanoid";
import { log } from "./config.js";
import { connectUpstream, upstreamTools } from "./upstream.js";
import { intercept } from "./interceptor.js";
import { remember, noteReasoning } from "./context.js";

const FETCH_TOOL = {
  name: "fetch_page",
  description:
    "Fetch a web page and return its text. Use this for all browsing — product pages, " +
    "listings, emails — before making any payment.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      reasoning: { type: "string", description: "Why you are reading this page" },
    },
    required: ["url"],
  },
};

export async function startMcpServer() {
  await connectUpstream();
  const sessionId = `ses_${nanoid(8)}`;

  const server = new Server(
    { name: "interlock", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // Re-expose every upstream tool under its identical name and schema, plus ours.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...upstreamTools(), FETCH_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args = {} } = req.params;

    if (name === "fetch_page") {
      const url = String((args as any).url);
      if ((args as any).reasoning) noteReasoning(sessionId, String((args as any).reasoning));
      const res = await fetch(url);
      const html = await res.text();
      remember(sessionId, url, html); // raw HTML, so hidden text survives for the scan
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
      return { content: [{ type: "text", text: text.replace(/\s+/g, " ").slice(0, 8000) }] };
    }

    return intercept(name, args as Record<string, unknown>, {
      sessionId,
      clientName: "mcp-client",
      // Keeps the connection alive while a payment waits on a human.
      sendProgress: (message) => {
        if (!extra?.sendNotification || !req.params._meta?.progressToken) return;
        extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: req.params._meta.progressToken, progress: 0, message },
        }).catch(() => {});
      },
    }) as any;
  });

  await server.connect(new StdioServerTransport());
  log(`MCP proxy ready, session ${sessionId}`);
}
