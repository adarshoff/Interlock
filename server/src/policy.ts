import { cfg } from "./config.js";
import { q } from "./db.js";
import type { Mandate, Payment, PolicyResult } from "./types.js";

/* ------------------------------------------------------------------ */
/* Confusable payees                                                   */
/* ------------------------------------------------------------------ */

/** Cyrillic and Greek letters that render like Latin ones, mapped to the letter they imitate. */
const LOOKALIKES: Record<string, string> = Object.fromEntries(
  [
    "аa", "сc", "ԁd", "еe", "һh", "іi", "јj", "кk", "ӏl", "оo", "рp", "ԛq", "ѕs", "уy", "хx", "ԝw", "үy", "вb",
    "АA", "ВB", "СC", "ЕE", "НH", "ІI", "ЈJ", "КK", "МM", "ОO", "РP", "ЅS", "ТT", "ХX", "УY",
    "αa", "οo", "ρp", "νv", "ιi", "κk", "υu", "τt",
    "ΑA", "ΒB", "ΕE", "ΖZ", "ΗH", "ΙI", "ΚK", "ΜM", "ΝN", "ΟO", "ΡP", "ΤT", "ΥY", "ΧX",
  ].map(([from, to]) => [from, to])
);

const SCRIPTS: Array<[string, RegExp]> = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Armenian", /\p{Script=Armenian}/u],
  ["Cherokee", /\p{Script=Cherokee}/u],
];
const scriptOf = (ch: string) =>
  SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? (/\p{L}/u.test(ch) ? "other" : null);
const INVISIBLE = /[\p{Cf}͏ᅟᅠㅤﾠ]/u;
const codePoint = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
const describe = (ch: string) => `"${ch}" (${codePoint(ch)}${scriptOf(ch) ? `, ${scriptOf(ch)}` : ""})`;

/** What the string would look like to a reader: lookalikes mapped to Latin, hidden characters gone. */
const skeleton = (s: string) =>
  [...s.normalize("NFKC")].map((ch) => LOOKALIKES[ch] ?? ch).join("").replace(new RegExp(INVISIBLE, "gu"), "");

/**
 * Why a payee-identifying string could be impersonating another, or null if it looks honest.
 * Emails must be plain ASCII (real internationalised domains travel as punycode). Names may be
 * accented Latin or wholly another script, but not a mix, not hidden characters, and not a
 * non-Latin string built entirely from letters that imitate Latin ones.
 */
export function confusableReason(value: string, kind: "email" | "name"): string | null {
  const chars = [...value];
  const hidden = chars.filter((c) => INVISIBLE.test(c));
  if (hidden.length) return `contains invisible character(s) ${hidden.map(describe).join(", ")}`;

  if (kind === "email") {
    const odd = chars.filter((c) => c < " " || c > "~");
    return odd.length ? `contains non-ASCII character(s) ${odd.map(describe).join(", ")}` : null;
  }

  if (value.normalize("NFKC") !== value) {
    const odd = chars.filter((c) => c.normalize("NFKC") !== c);
    return `contains full-width or compatibility character(s) ${odd.map(describe).join(", ")}`;
  }
  const letters = chars.filter((c) => scriptOf(c));
  const scripts = new Set(letters.map(scriptOf));
  if (scripts.size > 1) {
    const minority = letters.filter((c) => scriptOf(c) !== "Latin");
    return `mixes ${[...scripts].join(" and ")} letters: ${minority.map(describe).join(", ")}`;
  }
  if (letters.length && !scripts.has("Latin") && letters.every((c) => LOOKALIKES[c]))
    return `is written entirely in ${[...scripts][0]} letters that imitate Latin ones`;
  return null;
}

/** Every string in a money-moving call that names who is paid, billed, or doing the billing. */
function payeeIdentities(payment: Payment): Array<{ field: string; value: string; kind: "email" | "name" }> {
  const raw: any = payment.raw ?? {};
  const out: Array<{ field: string; value: string; kind: "email" | "name" }> = [];
  const add = (field: string, value: unknown, kind: "email" | "name") => {
    if (typeof value === "string" && value) out.push({ field, value, kind });
  };
  add("payee", payment.payee, payment.payee?.includes("@") ? "email" : "name");
  add("invoicer_email_address", raw.invoicer_email_address, "email");
  add("invoicer_business_name", raw.invoicer_business_name, "name");
  (Array.isArray(raw.primary_recipients) ? raw.primary_recipients : []).forEach((r: any, i: number) => {
    add(`primary_recipients[${i}].billing_info.email_address`, r?.billing_info?.email_address, "email");
    add(`primary_recipients[${i}].billing_info.business_name`, r?.billing_info?.business_name, "name");
    add(`primary_recipients[${i}].shipping_info.business_name`, r?.shipping_info?.business_name, "name");
  });
  (Array.isArray(raw.additional_recipients) ? raw.additional_recipients : []).forEach((v: unknown, i: number) =>
    add(`additional_recipients[${i}]`, v, "email"));
  (Array.isArray(raw.purchase_units) ? raw.purchase_units : []).forEach((pu: any, i: number) =>
    add(`purchase_units[${i}].payee.email_address`, pu?.payee?.email_address, "email"));
  return out;
}

/** Tools whose amount Interlock computes itself; for these, an unreadable amount is a hold, not $0. */
const AMOUNT_KNOWN_TOOLS = new Set(["create_order", "create_invoice", "send_invoice"]);

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
  // An invoice's spend is counted once, when it is created. Sending it is checked against the
  // single-payment cap, but adding it to running totals again would count the same money twice.
  const newSpend = payment.tool !== "send_invoice";

  if (mandate.amount_cap != null && amount > mandate.amount_cap)
    return {
      verdict: "block",
      rule: "amount_cap",
      detail: `Payment of ${amount} exceeds the single-payment cap of ${mandate.amount_cap}.`,
    };

  if (mandate.cumulative_cap != null && newSpend) {
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

  // Unknown is not zero. For tools whose amount Interlock can always read, failing to read it means
  // the caps above saw $0, so a person has to look.
  if (payment.amount == null && AMOUNT_KNOWN_TOOLS.has(payment.tool))
    return {
      verdict: "hold",
      rule: "amount_unknown",
      detail: `Interlock could not work out how much this ${payment.tool} is for, so the spending caps could not be checked.`,
    };

  // A payee that only looks like a known one is the impersonation the injection scanner cannot see.
  const confusable = cfg.policy.confusablePayee;
  if (confusable.action !== "off") {
    for (const id of payeeIdentities(payment)) {
      const reason = confusableReason(id.value, id.kind);
      if (reason)
        return {
          verdict: confusable.action,
          rule: "confusable_payee",
          detail: `${id.field} "${id.value}" ${reason}. It can look identical to "${skeleton(id.value)}".`,
        };
    }
  }

  // Splitting one purchase into payments that are each under the cap is still one purchase.
  const split = cfg.policy.splitPayment;
  if (split.action !== "off" && mandate.amount_cap != null && newSpend) {
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
