import { nanoid } from "nanoid";
import { cfg, MONEY_MOVING_TOOLS, log } from "./config.js";
import { q } from "./db.js";
import { evaluatePolicy, learnFromApproval } from "./policy.js";
import { runAiGates } from "./ai.js";
import { waitForHuman } from "./holds.js";
import { callUpstream } from "./upstream.js";
import { recentContext } from "./context.js";
import type { Mandate, Payment, Verdict } from "./types.js";

/**
 * The order total exactly as @paypal/agent-toolkit computes it before calling PayPal.
 * `itemTotal` is ignored upstream, so it is ignored here too: an agent cannot understate it to slip under a cap.
 */
function paypalOrderTotal(args: any): number | null {
  if (!Array.isArray(args?.items) || args.items.length === 0) return null;
  let total = 0;
  for (const item of args.items) {
    const cost = Number(item?.itemCost);
    const qty = Number(item?.quantity ?? 1);
    const tax = Number(item?.taxPercent ?? 0);
    if (![cost, qty, tax].every(Number.isFinite)) return null;
    total += cost * qty * (1 + tax / 100);
  }
  total += Number(args.shippingCost ?? 0) - Number(args.discount ?? 0);
  return Number.isFinite(total) ? Math.round(total * 100) / 100 : null;
}

/** Pull the amount, currency and payee out of whichever PayPal tool was called. */
export function extractPayment(tool: string, args: any): Payment {
  const pu = args?.purchase_units?.[0] ?? args?.purchaseUnits?.[0];
  const items = args?.items?.[0];
  const amount =
    (tool === "create_order" ? paypalOrderTotal(args) : null) ||
    Number(pu?.amount?.value) ||
    Number(args?.amount?.value) ||
    Number(items?.amount?.value) ||
    Number(args?.amount) ||
    null;
  const currency =
    args?.currencyCode ??
    pu?.amount?.currency_code ??
    args?.amount?.currency_code ??
    args?.currency ??
    "USD";
  const payee =
    pu?.payee?.email_address ??
    args?.payee?.email_address ??
    items?.receiver ??
    args?.receiver ??
    args?.merchant ??
    args?.payee ??
    null;
  const description = pu?.description ?? args?.description ?? args?.note ?? null;
  return { tool, amount: Number.isFinite(amount) ? amount : null, currency, payee, description, raw: args };
}

function refusal(reason: string, detail: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `PAYMENT REFUSED BY INTERLOCK.\n\n` +
          `Reason: ${reason}\n${detail}\n\n` +
          `This is a policy decision, not a transient error. Retrying this call ` +
          `with the same parameters will be refused again. Do not attempt a ` +
          `workaround. Tell the user what you were trying to pay for and why it ` +
          `was stopped, and let them decide.`,
      },
    ],
    isError: false, // a normal result, so the agent reports it instead of retrying
  };
}

export async function intercept(
  toolName: string,
  args: Record<string, unknown>,
  ctx: { sessionId: string; clientName: string; sendProgress?: (msg: string) => void }
) {
  // Read-only tools cost nothing and are never gated.
  if (!MONEY_MOVING_TOOLS.has(toolName)) return callUpstream(toolName, args);

  const mandate = q.activeMandate.get() as Mandate | undefined;
  if (!mandate)
    return refusal("no active mandate", "Nobody has authorised this agent to spend. Ask the user to create a mandate in Interlock.");

  q.insertSession.run({
    id: ctx.sessionId,
    mandate_id: mandate.id,
    client_name: ctx.clientName,
    started_at: Date.now(),
  });

  const payment = extractPayment(toolName, args);
  const { content, reasoning } = recentContext(ctx.sessionId);

  // Gate 1 — deterministic, cheapest, runs before any model call.
  const policy = evaluatePolicy(mandate, payment);

  // Gates 2 and 3 — skipped entirely if policy already hard-blocked.
  const ai =
    policy.verdict === "block"
      ? { intent: null, injection: null }
      : await runAiGates(mandate, payment, reasoning, content);

  // Combine: strictest wins.
  let verdict: Verdict = policy.verdict;
  let rule = policy.rule;
  let detail = policy.detail;

  if (ai.injection?.injection_detected && ai.injection.confidence >= 0.5) {
    verdict = "block";
    rule = "prompt_injection";
    detail = `The page the agent read contains instructions aimed at the agent (${ai.injection.technique}).`;
  } else if (ai.intent && !ai.intent.aligned && verdict !== "block") {
    verdict = "hold";
    rule = "intent_drift";
    detail = ai.intent.reason;
  }

  const txId = `tx_${nanoid(10)}`;
  const now = Date.now();

  q.insertTx.run({
    id: txId,
    session_id: ctx.sessionId,
    mandate_id: mandate.id,
    tool_name: toolName,
    arguments_json: JSON.stringify(args), // raw and unmodified — this is the evidence
    amount: payment.amount,
    currency: payment.currency,
    payee: payment.payee,
    verdict,
    rule,
    policy_json: JSON.stringify(policy),
    intent_json: ai.intent ? JSON.stringify(ai.intent) : null,
    injection_json: ai.injection ? JSON.stringify(ai.injection) : null,
    resolution: verdict === "allow" ? "auto" : null,
    created_at: now,
    resolved_at: verdict === "allow" ? now : null,
  });

  q.insertTrace.run({
    id: `tr_${nanoid(10)}`,
    transaction_id: txId,
    consumed_content: content.slice(0, 20000),
    agent_reasoning: reasoning,
    gate_outputs: JSON.stringify({ policy, ...ai }),
    created_at: now,
  });

  log(`${toolName} ${payment.amount} ${payment.currency} -> ${verdict}${rule ? ` (${rule})` : ""}`);

  if (verdict === "block") return refusal(rule ?? "blocked", detail ?? "");

  if (verdict === "hold") {
    ctx.sendProgress?.(`Interlock is holding this payment for approval (${rule}).`);
    const outcome = await waitForHuman(txId, cfg.holdTimeoutMs, (ms) =>
      ctx.sendProgress?.(`Still waiting on approval, ${Math.round(ms / 1000)}s elapsed.`)
    );
    q.resolveTx.run(outcome, Date.now(), txId);

    if (outcome !== "approved")
      return refusal(
        outcome === "denied" ? "declined by the account holder" : "approval timed out",
        detail ?? ""
      );

    learnFromApproval(mandate.id, rule, payment);
  }

  // Cleared: forward the original call untouched and return PayPal's real response.
  return callUpstream(toolName, args);
}
