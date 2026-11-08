# Interlock

A transparent MCP proxy that governs AI agent payments through PayPal.

Agents can now spend money through PayPal's MCP server. Nothing stops them
being tricked into spending it wrongly. Interlock is the checkpoint.

The agent points its MCP config at Interlock instead of at PayPal. Interlock
re-exposes PayPal's tools under identical names, so the agent needs no
modification. Every money-moving call passes three gates before it is
forwarded: deterministic policy rules, an AI intent-alignment check, and a
prompt-injection scan of the content the agent read.

Cleared calls go through untouched. Suspicious ones pause mid-flight and wait
on a human. Everything is recorded, and the record later serves as dispute
evidence.

---

## Step by step

### 1 — Install

```bash
cd server && npm install
cd ../console && npm install
```

### 2 — Configure

```bash
cd server && cp .env.example .env
```

Fill in `PAYPAL_ACCESS_TOKEN` from your PayPal Developer sandbox app.
Leave `ANTHROPIC_API_KEY` empty for now — the AI gates fall back to
heuristics so you can build the proxy without a model in the loop.

### 3 — Seed and run

```bash
cd server
npm run seed     # 4,000 synthetic payments + one active mandate
npm run dev      # MCP proxy on stdio, console API on :8787
```

```bash
cd console && npm run dev    # http://localhost:5173
```

### 4 — Point an agent at it

Claude Desktop, `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "paypal": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/interlock/server/src/index.ts"]
    }
  }
}
```

That is the whole integration. One line changes; the agent is unaware.

### 5 — Verify the critical path

This is the day-3 go/no-go gate. Ask the agent to create a sandbox order
above the mandate's `$200` cap. Expect:

1. the call reaches Interlock, not PayPal
2. it appears under **Waiting on you** in the console
3. the agent's tool call stays open, neither erroring nor timing out
4. pressing **Approve payment** forwards it to PayPal and the agent carries on

If this does not work, nothing else in the project matters yet. Fix it before
building anything else.

### 6 — Turn the AI gates on

Add `ANTHROPIC_API_KEY` to `.env` and restart. Intent drift and prompt
injection are now caught by a model rather than by regexes.

### 7 — Run the attack suite

```bash
cd attack-suite && npx tsx run.ts
```

Publish the table it prints, misses included.

---

## How it fits together

```
agent (unmodified)
      |  MCP, identical tool names
      v
Interlock proxy ── gate 1  policy rules      deterministic, no model
      |            gate 2  intent check      payment vs mandate
      |            gate 3  injection scan    content the agent read
      |
      ├── hold ──> console, human decides, call resumes
      └── allow ─> PayPal MCP + APIs (response returned untouched)

every path writes to an append-only trace -> dispute evidence
```

| File | What it owns |
| --- | --- |
| `server/src/upstream.ts` | MCP client facing PayPal |
| `server/src/mcp.ts` | MCP server facing the agent, plus `fetch_page` |
| `server/src/interceptor.ts` | Gate sequencing and the verdict |
| `server/src/holds.ts` | Suspend and resume an in-flight tool call |
| `server/src/policy.ts` | Deterministic rules, and learning from approvals |
| `server/src/ai.ts` | Intent check and injection scan |
| `server/src/api.ts` | Console API |
| `console/src/Approvals.tsx` | The screen that is on camera |
| `console/src/Transactions.tsx` | AG Grid: master/detail, grouping, server-side rows |
| `attack-suite/` | Eleven hosted pages and the benchmark runner |

---

## Three things that are easy to get wrong

**stdout belongs to the MCP protocol.** Every log line goes to stderr. A single
`console.log` corrupts the JSON-RPC stream and the agent disconnects without
explaining why. See `log()` in `config.ts`.

**A refusal is a result, not an error.** `interceptor.ts` returns a normal tool
result whose text says plainly that retrying will fail. Return an error instead
and agents retry in a loop or invent a workaround. Treat that text as a prompt
and test it.

**The detector must not itself be injectable.** Scanned content is wrapped in
delimiters and the system prompt states that nothing inside is an instruction.

---

## Status

Built for the PayPal AI Hackathon. Sandbox only.

Dispute submission generates the full evidence package from the stored trace;
whether the final API call lands depends on sandbox support — see
`api.ts:/api/transactions/:id/dispute`.

MIT licensed.
