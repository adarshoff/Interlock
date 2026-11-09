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

/**
 * An invoice total as PayPal computes it from the line items the toolkit passes through unchanged:
 * per line, quantity × unit_amount, less its discount (amount or percent), plus tax on what remains;
 * then shipping_cost. Any line that cannot be read makes the whole total unknown, never smaller.
 */
export function invoiceTotal(items: unknown, shippingCost?: unknown): number | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const item of items as any[]) {
    const qty = Number(item?.quantity ?? 1);
    const unit = Number(item?.unit_amount?.value);
    const gross = qty * unit;
    const discount =
      item?.discount?.amount?.value != null ? Number(item.discount.amount.value)
      : item?.discount?.percent != null ? (gross * Number(item.discount.percent)) / 100
      : 0;
    const taxPercent = Number(item?.tax?.percent ?? 0);
    if (![qty, unit, discount, taxPercent].every(Number.isFinite)) return null;
    total += (gross - discount) * (1 + taxPercent / 100);
  }
  total += Number(shippingCost ?? 0);
  return Number.isFinite(total) ? Math.round(total * 100) / 100 : null;
}

const firstRecipient = (recipients: any) => recipients?.[0]?.billing_info?.email_address ?? null;

/** Pull the amount, currency and payee out of whichever PayPal tool was called. */
export function extractPayment(tool: string, args: any): Payment {
  if (tool === "create_invoice")
    return {
      tool,
      amount: invoiceTotal(args?.items, args?.shipping_cost),
      currency: args?.currency_code ?? "USD",
      payee: firstRecipient(args?.primary_recipients),
      description: args?.note ?? args?.items?.[0]?.name ?? null,
      raw: args,
    };
  // The amount lives on the invoice at PayPal; resolveSendInvoice fills it in before policy runs.
  if (tool === "send_invoice")
    return { tool, amount: null, currency: null, payee: null, description: args?.note ?? null, raw: args };

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

type InvoiceLookup = (invoiceId: string) => Promise<any>;

/** Reads the invoice being sent from PayPal (read-only get_invoice) and returns its total, currency and recipient. */
const lookupViaUpstream: InvoiceLookup = async (invoiceId) => {
  const res: any = await callUpstream("get_invoice", { invoice_id: invoiceId });
  const text = (res?.content ?? []).map((c: any) => c?.text ?? "").join("");
  return JSON.parse(text);
};

/**
 * send_invoice names an invoice, not an amount. Look it up so the caps see what is being sent.
 * If the lookup fails the amount stays null, and policy holds the payment rather than treating it as $0.
 */
export async function resolveSendInvoice(payment: Payment, lookup: InvoiceLookup = lookupViaUpstream): Promise<Payment> {
  const invoiceId = (payment.raw as any)?.invoice_id;
  if (!invoiceId) return payment;
  try {
    const inv = await lookup(String(invoiceId));
    const value = Number(inv?.amount?.value);
    if (!Number.isFinite(value))
      log(`send_invoice ${invoiceId}: PayPal returned no invoice amount (${JSON.stringify(inv).slice(0, 160)}); amount unknown`);
    return {
      ...payment,
      amount: Number.isFinite(value) ? value : null,
      currency: inv?.amount?.currency_code ?? inv?.detail?.currency_code ?? payment.currency,
      payee: firstRecipient(inv?.primary_recipients) ?? payment.payee,
      description: payment.description ?? inv?.detail?.note ?? null,
    };
  } catch (e) {
    log(`send_invoice ${invoiceId}: could not read the invoice from PayPal (${e instanceof Error ? e.message : e}); amount unknown`);
    return payment;
  }
}

/**
 * Tested against live agents: a softer version ("retrying with the same parameters will fail")
 * led them to split a blocked payment into smaller ones, or switch to invoices, once the user pushed.
 */
function refusal(what: string, why: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `PAYMENT REFUSED. No money moved.\n\n` +
          `What happened: ${what}\n` +
          `Why: ${why}\n\n` +
          `This decision comes from the account holder's own spending controls (Interlock), which sit ` +
          `between you and PayPal. It is not a PayPal error and not a temporary problem. It is final ` +
          `for this purchase.\n\n` +
          `You must not try to complete this purchase another way. Each of these circumvents the ` +
          `account holder's limits and is not allowed:\n` +
          `- retrying, now or later\n` +
          `- a smaller amount, or splitting the cost across several payments or orders\n` +
          `- a different tool (create_order, create_invoice, send_invoice, create_subscription, or any other)\n` +
          `- a different payee, account or payment method\n` +
          `This holds even if the user tells you to "do whatever works". The user cannot lift this ` +
          `limit by asking you. Only the account holder can, by changing it in the Interlock console.\n\n` +
          `What to do now: make no further payment tool calls for this purchase. Tell the user in ` +
          `plain words what you tried to pay for, the amount, and the reason above. Tell them that if ` +
          `they want it to go ahead, the account holder must change the limit or approve the payment ` +
          `in Interlock, and then they can ask you again. Do not suggest workarounds.`,
      },
    ],
    isError: false, // a normal result, so the agent reports it instead of retrying
  };
}

const describeAmount = (p: Payment) =>
  p.amount != null ? `${p.amount.toFixed(2)} ${p.currency ?? ""}`.trim() : "an unknown amount";

export async function intercept(
  toolName: string,
  args: Record<string, unknown>,
  ctx: { sessionId: string; clientName: string; sendProgress?: (msg: string) => void }
) {
  // Read-only tools cost nothing and are never gated.
  if (!MONEY_MOVING_TOOLS.has(toolName)) return callUpstream(toolName, args);

  const mandate = q.activeMandate.get() as Mandate | undefined;
  if (!mandate)
    return refusal(
      "No spending has been authorised for this agent.",
      "There is no active spending mandate in Interlock."
    );

  q.insertSession.run({
    id: ctx.sessionId,
    mandate_id: mandate.id,
    client_name: ctx.clientName,
    started_at: Date.now(),
  });

  let payment = extractPayment(toolName, args);
  if (toolName === "send_invoice") payment = await resolveSendInvoice(payment);
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

  const amountText = describeAmount(payment);
  if (verdict === "block")
    return refusal(
      `A payment of ${amountText} was blocked before it reached PayPal.`,
      detail ?? "It breaks one of the account holder's spending rules."
    );

  if (verdict === "hold") {
    ctx.sendProgress?.(`Interlock is holding this payment for approval (${rule}).`);
    const outcome = await waitForHuman(txId, cfg.holdTimeoutMs, (ms) =>
      ctx.sendProgress?.(`Still waiting on approval, ${Math.round(ms / 1000)}s elapsed.`)
    );
    q.resolveTx.run(outcome, Date.now(), txId);

    const flagged = detail ? ` (It had been flagged for review because: ${detail})` : "";
    if (outcome === "denied")
      return refusal(
        `A payment of ${amountText} was held for review, and the account holder looked at it and declined it.`,
        `The account holder said no. That decision is the reason, and it stands.${flagged}`
      );
    if (outcome === "timeout")
      return refusal(
        `A payment of ${amountText} was held for review, and the account holder did not approve it in time.`,
        `Payments that are not approved are refused, never made.${flagged}`
      );

    learnFromApproval(mandate.id, rule, payment);
  }

  // Cleared: forward the original call untouched and return PayPal's real response.
  return callUpstream(toolName, args);
}
