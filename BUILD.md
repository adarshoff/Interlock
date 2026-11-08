# Build plan

Nine phases. One per Claude Code session. Each has an acceptance test — do not
move on until it passes, and commit when it does.

Paste the phase heading and its body as your prompt. `CLAUDE.md` supplies the
project context automatically, so you never re-explain the architecture.

---

## Phase 1 — Upstream connection

> Get `server/src/upstream.ts` connecting to PayPal's MCP server and listing
> its tools. Run `npm run dev` and fix whatever stops it. Do not touch any
> other file. If the upstream command or env var names in `.env.example` are
> wrong for the current `@paypal/mcp` package, correct them and tell me what
> changed.

**Acceptance:** stderr prints `upstream connected, N tools:` followed by real
PayPal tool names.

**If this fails for more than a session**, the whole project is at risk — see
the fallback at the bottom of this file.

---

## Phase 2 — Transparent proxy

> Point Claude Desktop at Interlock by editing `claude_desktop_config.json` to
> run `npx tsx <abs-path>/server/src/index.ts`. Confirm the agent sees PayPal's
> tools under their real names plus `fetch_page`. Ask the agent to call a
> read-only PayPal tool and confirm it passes straight through with no gating.
> Fix anything in `mcp.ts` that breaks tool listing or pass-through.

**Acceptance:** Claude Desktop lists the tools and a read-only call returns
PayPal's real response.

---

## Phase 3 — Hold and resume (the critical path)

> Seed the database, then ask the agent to create a sandbox order for an amount
> over the mandate's $200 cap. Verify: the call reaches `interceptor.ts`, the
> verdict is `hold`, the row appears at `GET /api/pending`, the agent's tool
> call stays open without erroring, `POST /api/transactions/:id/approve`
> resumes it, and PayPal's real response reaches the agent.
>
> Fix `holds.ts`, `interceptor.ts` or `mcp.ts` as needed. Pay attention to the
> progress-notification heartbeat — if the connection drops during a hold, that
> is the bug.

**Acceptance:** a held payment completes successfully after approval, and the
agent continues its task as though nothing happened.

**This is the day-3 go/no-go gate.** Everything after this is depth.

---

## Phase 4 — Refusal wording

> Test the two refusal paths: a hard block (amount over cap) and a denial. For
> each, check what the agent does next. It must report the refusal to the user
> and stop — not retry, not try a smaller amount, not call a different tool to
> work around it.
>
> If it retries or works around the block, rewrite the `refusal()` text in
> `interceptor.ts` and test again. Treat that string as a prompt.

**Acceptance:** a blocked agent explains the block to the user and stops.

---

## Phase 5 — AI gates

> Add `ANTHROPIC_API_KEY` to `.env`. Test the intent check with a payment that
> is within the cap but off-task (a $40 gift card under a hotel-booking
> mandate) and confirm it holds with a readable reason. Then serve
> `attack-suite/pages/01-hidden-instruction.html` locally, have the agent read
> it via `fetch_page` and attempt the induced payment, and confirm the
> injection scan blocks it and returns the hidden text verbatim.
>
> Tune the prompts in `ai.ts` until the `reason` field reads like something a
> person would understand on their phone in five seconds.

**Acceptance:** both gates fire correctly, and the injected span is captured
verbatim.

---

## Phase 6 — Attack suite

> Write the remaining eight pages in `attack-suite/pages/`, following the
> numbering already there: 03 poisoned review, 04 confusable merchant, 05
> invoice injection, 06 multi-turn setup, 07 budget drift (no injection at
> all), 08 urgency pressure, 09 tool-name confusion, 10 encoded instruction.
> Add one more benign control alongside `11-benign-control.html`.
>
> Each page must look like a plausible real page to a human reader. Then run
> `npx tsx run.ts` and give me the detection table.

**Acceptance:** the runner prints a table over all 12 pages with a detection
count and a false-positive count.

**Put that table in the README, misses included.** This is your credibility.

---

## Phase 7 — Approvals screen

> `console/src/Approvals.tsx` is the screen that appears in the demo video.
> Make it excellent. The hierarchy is: amount and payee first, then what the
> user authorised, then why this stopped, then the injected span if there is
> one, then the two buttons. The countdown must be visibly live.
>
> Do not restructure the app or add screens. One file, one session.

**Acceptance:** a held payment with an injection renders clearly enough that
someone unfamiliar with the project understands what happened in five seconds.

---

## Phase 8 — Second client

> Get a second MCP client working against the same proxy with no code changes
> — Cursor, or a small LangChain or Vercel AI SDK agent in a new `examples/`
> folder. Fix any transport assumptions in `mcp.ts` that only hold for Claude
> Desktop.

**Acceptance:** two different agents, both unmodified, both governed.

**This is your strongest single claim.** It is what turns the project from an
app into infrastructure.

---

## Phase 9 — Disputes (optional)

> Wire `POST /api/transactions/:id/dispute` through to PayPal's Disputes API.
> Check sandbox support first. If submission is not available, generate and
> display the full evidence package, leave the final call stubbed, and state
> that plainly in the README.

**Acceptance:** an evidence package assembled entirely from the stored trace.

---

## Then stop coding

Two days: demo video and Devpost writeup. No new features.

**Video, three minutes.** Premise in the first fifteen seconds — agents can now
spend your money and nothing is watching. Then a clean purchase passing
through. Then the attack, taken by the agent, caught by Interlock, with the
hidden text on screen. Then the same proxy governing a second agent. Then the
benchmark table including the misses. End on the console.

Shoot it twice. The first take is always too long and too proud of the
architecture.

---

## Fallback

If Phase 3 is not passing by day 3, abandon Interlock and build the
chargeback-defence tool instead: AI monitors sandbox disputes, assembles
evidence from order records, drafts and files rebuttals through PayPal's
Disputes API. Weaker on innovation, strong on impact, and buildable in the
time remaining. The database layer and console transfer directly.
