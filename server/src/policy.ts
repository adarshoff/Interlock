import { cfg } from "./config.js";
import { q } from "./db.js";
import type { Mandate, Payment, PolicyResult } from "./types.js";

/**
 * Deterministic. No model is consulted here, ever.
 * A hard spending limit enforced by an LLM is not a limit.
 *
 * Runs before the AI gates because it is the cheapest and the strictest:
 * a payment that busts a ceiling never costs a model call.
 */
export function evaluatePolicy(mandate: Mandate, payment: Payment): PolicyResult {
  const now = Date.now();
  const pass: PolicyResult = { verdict: "allow", rule: null, detail: null };

  if (mandate.status !== "active")
    return { verdict: "block", rule: "mandate_status", detail: `Mandate is ${mandate.status}.` };

  if (now > mandate.expires_at)
    return { verdict: "block", rule: "expiry", detail: "Mandate expired." };

  const amount = payment.amount ?? 0;

  if (mandate.amount_cap != null && amount > mandate.amount_cap)
    return {
      verdict: "block",
      rule: "amount_cap",
      detail: `Payment of ${amount} exceeds the single-payment cap of ${mandate.amount_cap}.`,
    };

  if (mandate.cumulative_cap != null) {
    const spent = (q.spentSoFar.get(mandate.id) as { total: number }).total;
    if (spent + amount > mandate.cumulative_cap)
      return {
        verdict: "block",
        rule: "cumulative_cap",
        detail: `Would take total spend to ${spent + amount}, over the ${mandate.cumulative_cap} limit.`,
      };
  }

  // Rules the user (or past approvals) added for this mandate.
  const rules = q.policiesFor.all(mandate.id) as Array<{ rule_type: string; value: string; source: string }>;
  const allow = rules.filter((r) => r.rule_type === "merchant_allow").map((r) => r.value.toLowerCase());
  const block = rules.filter((r) => r.rule_type === "merchant_block").map((r) => r.value.toLowerCase());
  const velocity = rules.find((r) => r.rule_type === "velocity_per_hour");

  const payee = (payment.payee ?? "").toLowerCase();

  if (payee && block.some((b) => payee.includes(b)))
    return { verdict: "block", rule: "merchant_block", detail: `${payment.payee} is on the blocklist.` };

  // Splitting one purchase into payments that are each under the cap is still one purchase.
  const split = cfg.policy.splitPayment;
  if (split.action !== "off" && mandate.amount_cap != null) {
    const recent = q.spentToPayeeSince.get(mandate.id, payment.payee, now - split.windowMs) as { total: number; n: number };
    const combined = Math.round((recent.total + amount) * 100) / 100;
    if (recent.n > 0 && combined > mandate.amount_cap)
      return {
        verdict: split.action,
        rule: "split_payment",
        detail:
          `With ${recent.n} earlier payment(s) to ${payment.payee ?? "this merchant"} in the last ` +
          `${split.windowMs / 60_000} minutes, the total would be ${combined}, over the ` +
          `single-payment cap of ${mandate.amount_cap}. That looks like one purchase split up.`,
      };
  }

  // An agent paying again straight after being refused is retrying or working around it.
  const after = cfg.policy.afterRefusal;
  if (after.action !== "off") {
    const last = q.lastRefusalSince.get(mandate.id, now - after.windowMs) as
      | { created_at: number; verdict: string; rule: string | null; resolution: string | null }
      | undefined;
    if (last) {
      const how = last.verdict === "block" ? `blocked (${last.rule ?? "policy"})` : last.resolution;
      return {
        verdict: after.action,
        rule: "after_refusal",
        detail:
          `A payment under this mandate was ${how} ${Math.round((now - last.created_at) / 1000)}s ago. ` +
          `A new payment straight after a refusal may be a retry or a workaround.`,
      };
    }
  }

  if (velocity) {
    const n = (q.countSince.get(mandate.id, now - 3_600_000) as { n: number }).n;
    if (n >= Number(velocity.value))
      return {
        verdict: "hold",
        rule: "velocity",
        detail: `${n} payments already in the last hour, limit is ${velocity.value}.`,
      };
  }

  if (payee) {
    const known = allow.some((a) => payee.includes(a));
    const seen = (q.seenPayee.get(mandate.id, payment.payee!) as { n: number }).n > 0;
    if (!known && !seen)
      return {
        verdict: "hold",
        rule: "new_payee",
        detail: `First payment to ${payment.payee} under this mandate.`,
      };
  }

  return pass;
}

/**
 * When a human approves a held payment, remember why it was held so the same
 * payment does not interrupt them twice. This is what makes the system feel
 * like it is learning rather than nagging.
 */
export function learnFromApproval(mandateId: string, rule: string | null, payment: Payment) {
  if (rule !== "new_payee" || !payment.payee) return;
  q.insertPolicy.run({
    id: `pol_${Date.now().toString(36)}`,
    mandate_id: mandateId,
    rule_type: "merchant_allow",
    value: payment.payee,
    source: "learned",
    created_at: Date.now(),
  });
}
