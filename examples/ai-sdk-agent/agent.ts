// A generic Vercel AI SDK agent that uses PayPal's MCP tools. It does not know Interlock exists:
// it launches the MCP server the same way Claude Desktop does, which happens to be Interlock.
//   GROQ_API_KEY=... npm start -- "List the products in my PayPal catalog."
import "dotenv/config";
import { generateText, stepCountIs } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { fileURLToPath } from "node:url";

const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const prompt = process.argv.slice(2).join(" ") || "List the products in my PayPal catalog.";
const model = process.env.AGENT_MODEL ?? "openai/gpt-oss-120b";
// Groq's free tier caps a request at ~8k tokens, and all 29 tool schemas exceed it. Offer the model a subset.
const offered = (process.env.AGENT_TOOLS ??
  "fetch_page,list_products,create_order,get_order,create_invoice,send_invoice,get_invoice,list_invoices").split(",");

const mcp = await createMCPClient({
  transport: new StdioMCPTransport(
    process.platform === "win32"
      ? { command: "cmd", args: ["/c", "npm", "--prefix", serverDir, "--silent", "start"] }
      : { command: "npm", args: ["--prefix", serverDir, "--silent", "start"] }
  ),
});

try {
  const all = await mcp.tools();
  const tools = Object.fromEntries(Object.entries(all).filter(([name]) => offered.includes(name)));
  console.log(`connected to "${mcp.serverInfo.name}": ${Object.keys(all).length} tools, offering ${Object.keys(tools).length} to ${model}\n`);

  const result = await generateText({
    model: createGroq()(model),
    system: "You are a helpful assistant with PayPal tools. Use them to do what the user asks, then report what happened.",
    prompt,
    tools,
    stopWhen: stepCountIs(8),
    onStepFinish: ({ toolCalls, toolResults }) => {
      for (const call of toolCalls) console.log(`→ ${call.toolName} ${JSON.stringify(call.input).slice(0, 160)}`);
      for (const r of toolResults) {
        const text = ((r.output as any)?.content ?? []).map((c: any) => c.text ?? "").join(" ");
        console.log(`← ${r.toolName}: ${text.replace(/\s+/g, " ").slice(0, 220)}`);
      }
    },
  });
  console.log(`\n${result.text}`);
} finally {
  await mcp.close();
}
