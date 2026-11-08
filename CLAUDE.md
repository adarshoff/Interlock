# Interlock

A transparent MCP proxy that governs AI agent payments through PayPal.

```
agent (unmodified) → Interlock → 3 gates → PayPal MCP + APIs
                         ↓
                   hold → human approves in console → call resumes
```

The agent points its MCP config at Interlock instead of PayPal. Interlock
re-exposes PayPal's tools under identical names, so the agent needs no
modification and cannot tell it is being governed.

## Non-negotiable rules

- **stdout belongs to the MCP protocol.** Every log line goes to stderr via
  `log()` in `config.ts`. A single `console.log` corrupts the JSON-RPC stream
  and the agent disconnects silently.
- **Refusals return a normal tool result, never an error.** The text must tell
  the model plainly that retrying will fail. An error makes agents retry in a
  loop or invent workarounds.
- **Hard spending limits live in `policy.ts` as code.** A model is never asked
  to enforce arithmetic.
- **The `traces` table is append-only.** Never UPDATE it.
- **Scanned content is untrusted data.** It is always wrapped in delimiters
  with an explicit instruction that nothing inside is an instruction.
- **The agent is never modified.** If a change would require editing the
  agent, it is the wrong change.

## Stack

TypeScript throughout. `@modelcontextprotocol/sdk`, `better-sqlite3`,
`express`. Console is React + Vite + AG Grid Enterprise.

```bash
cd server && npm run dev      # MCP proxy on stdio, API on :8787
cd console && npm run dev     # http://localhost:5173
cd server && npm run seed     # 4,000 synthetic payments
```

## Layout

| Path | Owns |
| --- | --- |
| `server/src/upstream.ts` | MCP client facing PayPal |
| `server/src/mcp.ts` | MCP server facing the agent, plus `fetch_page` |
| `server/src/interceptor.ts` | Gate sequencing and the verdict |
| `server/src/holds.ts` | Suspend and resume an in-flight tool call |
| `server/src/policy.ts` | Deterministic rules, learning from approvals |
| `server/src/ai.ts` | Intent check and injection scan |
| `server/src/api.ts` | Console API |
| `console/src/Approvals.tsx` | The screen that is on camera |
| `console/src/Transactions.tsx` | AG Grid: master/detail, grouping, SSRM |
| `attack-suite/` | Hosted attack pages and the benchmark runner |

## Working style

One phase per session. Run it, confirm the acceptance test passes, commit,
stop. Never generate several files at once without running them. See `BUILD.md`
for the phases.

## Current state

Phases 1–5 complete and committed, verified against the live PayPal sandbox:

- AI gates working on Groq (`AI_PROVIDER=groq`, `openai/gpt-oss-120b`); a
  configured provider that errors fails closed and holds.
- `extractPayment` fixed for PayPal's real `create_order` shape
  (`currencyCode` + `items[]`), computing the total as the toolkit does.
- `MONEY_MOVING_TOOLS` corrected to the real upstream tool names.
- Process lifecycle handled: exits when the agent closes stdin, kills the
  PayPal subprocess tree, and a busy console API port is non-fatal.
- Refusal wording hardened after adversarial testing: 6 of 8 baseline runs
  worked around the old text, and two defeated the cap by splitting $340 into
  $200 + $140 with real sandbox orders.
- `split_payment` and `after_refusal` rules added to `policy.ts`, each with a
  configurable action and window, covered by 10 tests in
  `server/test/policy.test.ts`.

Known gaps:

- `create_order` has no attacker-controllable payee: the order is created on
  the merchant account that owns the token. Injection attacks that redirect
  money must target `create_invoice` / `send_invoice` instead.
- Refunds do not fit the mandate model. `create_refund` returns money to a
  buyer rather than spending against a mandate's caps, so policy has no
  meaningful rule for it yet.
- The console API does not retry binding its port. A restart race can leave
  the proxy running with no way to approve holds, and every hold then times
  out.
<!-- update this line at the end of every session -->
