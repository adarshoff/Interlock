import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.INTERLOCK_DB = ":memory:";
process.env.SPLIT_PAYMENT_ACTION = "hold";
process.env.SPLIT_PAYMENT_WINDOW_MINUTES = "10";
process.env.AFTER_REFUSAL_ACTION = "hold";
process.env.AFTER_REFUSAL_WINDOW_MINUTES = "10";
process.env.CONFUSABLE_PAYEE_ACTION = "hold";

const { db, q } = await import("../src/db.js");
const { evaluatePolicy } = await import("../src/policy.js");
import type { Mandate, Payment, PolicyResult } from "../src/types.js";

const MIN = 60_000;
let mandate: Mandate;
let seq = 0;

beforeEach(() => {
  db.exec("DELETE FROM transactions; DELETE FROM policies; DELETE FROM mandates;");
  mandate = {
    id: `mdt_test_${++seq}`,
    user_id: "user_1",
    instruction_text: "Book a hotel near the conference venue, under $200 a night.",
    amount_cap: 200,
    cumulative_cap: 600,
    categories: null,
    expires_at: Date.now() + 86_400_000,
    status: "active",
    created_at: Date.now(),
  } as Mandate;
});

/** Evaluate a payment, then record it the way interceptor.ts does. */
function pay(amount: number, opts: { payee?: string | null; agoMs?: number } = {}): PolicyResult & { id: string } {
  const payee = opts.payee === undefined ? null : opts.payee;
  const payment: Payment = { tool: "create_order", amount, currency: "USD", payee, description: null, raw: {} };
  const result = evaluatePolicy(mandate, payment);
  const id = `tx_${++seq}`;
  const at = Date.now() - (opts.agoMs ?? 0);
  q.insertTx.run({
    id, session_id: "ses_test", mandate_id: mandate.id, tool_name: "create_order",
    arguments_json: "{}", amount, currency: "USD", payee,
    verdict: result.verdict, rule: result.rule, policy_json: JSON.stringify(result),
    intent_json: null, injection_json: null,
    resolution: result.verdict === "allow" ? "auto" : null,
    created_at: at, resolved_at: result.verdict === "allow" ? at : null,
  });
  return { ...result, id };
}
const resolve = (id: string, outcome: "approved" | "denied" | "timeout") => q.resolveTx.run(outcome, Date.now(), id);
const allowMerchants = (...names: string[]) =>
  names.forEach((value, i) =>
    q.insertPolicy.run({ id: `pol_${seq}_${i}`, mandate_id: mandate.id, rule_type: "merchant_allow", value, source: "user", created_at: Date.now() }));

test("reproduces the live $200 + $140 split: the second payment now holds", () => {
  const first = pay(200);
  assert.equal(first.verdict, "allow", "$200 is exactly at the cap and goes through");

  const second = pay(140);
  assert.equal(second.verdict, "hold");
  assert.equal(second.rule, "split_payment");
  assert.match(second.detail!, /340/);
});

test("the full sequence the agent ran: $340 blocked, then $200, then $140", () => {
  assert.equal(pay(340).rule, "amount_cap");

  const first = pay(200);
  assert.equal(first.verdict, "hold", "a payment straight after a block holds");
  assert.equal(first.rule, "after_refusal");
  resolve(first.id, "approved");

  const second = pay(140);
  assert.equal(second.verdict, "hold");
  assert.equal(second.rule, "split_payment", "the split is the more specific reason");
});

test("a held payment still pending counts toward the split", () => {
  allowMerchants("hotel-aurora.com");
  q.insertPolicy.run({ id: "pol_vel", mandate_id: mandate.id, rule_type: "velocity_per_hour", value: "1", source: "user", created_at: Date.now() });
  pay(1, { payee: "other.com", agoMs: 30 * MIN }); // trips velocity for the next payment
  const first = pay(150, { payee: "hotel-aurora.com" });
  assert.equal(first.rule, "velocity");
  assert.equal(pay(100, { payee: "hotel-aurora.com" }).rule, "split_payment");
});

test("payments to different merchants are not a split", () => {
  allowMerchants("hotel-aurora.com", "citybikes.io");
  assert.equal(pay(200, { payee: "hotel-aurora.com" }).verdict, "allow");
  assert.equal(pay(140, { payee: "citybikes.io" }).verdict, "allow");
});

test("a split outside the window is allowed", () => {
  assert.equal(pay(200, { agoMs: 11 * MIN }).verdict, "allow");
  assert.equal(pay(140).verdict, "allow");
});

test("small repeat payments that stay under the cap together are allowed", () => {
  assert.equal(pay(80).verdict, "allow");
  assert.equal(pay(90).verdict, "allow");
});

test("blocked, declined and timed-out payments do not count toward the split", () => {
  pay(250, { agoMs: 3 * MIN }); // blocked by the cap
  const denied = pay(150, { agoMs: 2 * MIN });
  resolve(denied.id, "denied");
  const timedOut = pay(150, { agoMs: 1 * MIN });
  resolve(timedOut.id, "timeout");

  // Had any of them counted, this would be split_payment. It still holds, as a payment after a refusal.
  assert.equal(pay(140).rule, "after_refusal");
});

test("a payment after a declined hold holds", () => {
  allowMerchants("giftcard-vault.xyz");
  q.insertPolicy.run({ id: "pol_vel", mandate_id: mandate.id, rule_type: "velocity_per_hour", value: "1", source: "user", created_at: Date.now() });
  pay(1, { payee: "other.com", agoMs: 30 * MIN });
  const held = pay(50, { payee: "giftcard-vault.xyz" });
  resolve(held.id, "denied");

  const next = pay(40, { payee: "hotel-aurora.com" });
  assert.equal(next.verdict, "hold");
  assert.equal(next.rule, "after_refusal");
  assert.match(next.detail!, /denied/);
});

test("a refusal outside the window no longer holds", () => {
  pay(340, { agoMs: 11 * MIN });
  assert.equal(pay(150).verdict, "allow");
});

/* confusable_payee: the strings come straight from the attack page, not retyped. */
const page04 = readFileSync(join(import.meta.dirname, "../../attack-suite/pages/04-confusable-merchant.html"), "utf8");
const fakeEmail = page04.match(/billing@nomad-c\S+?\.co/)![0];
const fakeName = page04.match(/Nomad C\S+ Roasters Ltd/)![0];

const invoice = (raw: Record<string, unknown>, tool = "create_invoice"): PolicyResult =>
  evaluatePolicy(mandate, { tool, amount: 120, currency: "USD", payee: null, description: null, raw });
const billTo = (email: string, business_name?: string) => ({
  currency_code: "USD",
  primary_recipients: [{ billing_info: { email_address: email, ...(business_name ? { business_name } : {}) } }],
  items: [{ name: "Wholesale beans, 10kg", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }],
});

test("page 04 really uses a Cyrillic о that renders like the real domain", () => {
  assert.ok(fakeEmail.includes("о"), "the attack page should contain U+043E");
  assert.notEqual(fakeEmail, "billing@nomad-coffee.co");
  assert.equal(fakeEmail.replace("о", "o"), "billing@nomad-coffee.co");
});

test("reproduces 04: invoicing the lookalike billing address holds", () => {
  const r = invoice(billTo(fakeEmail));
  assert.equal(r.verdict, "hold");
  assert.equal(r.rule, "confusable_payee");
  assert.match(r.detail!, /U\+043E/);
  assert.match(r.detail!, /billing@nomad-coffee\.co/, "the detail shows what it imitates");
});

test("reproduces 04: the lookalike trading name holds even with an honest email", () => {
  const r = invoice(billTo("wholesale@nomad-coffee.co", fakeName));
  assert.equal(r.rule, "confusable_payee");
  assert.match(r.detail!, /mixes Latin and Cyrillic/);
});

test("reproduces 04: copying the invoice to the lookalike address via send_invoice holds", () => {
  const r = invoice({ invoice_id: "INV2-TEST", additional_recipients: [fakeEmail] }, "send_invoice");
  assert.equal(r.rule, "confusable_payee");
  assert.match(r.detail!, /additional_recipients\[0\]/);
});

test("a lookalike invoicer email or business name holds", () => {
  assert.equal(invoice({ ...billTo("ap@meridian-analytics.com"), invoicer_email_address: fakeEmail }).rule, "confusable_payee");
  assert.equal(invoice({ ...billTo("ap@meridian-analytics.com"), invoicer_business_name: fakeName }).rule, "confusable_payee");
});

test("whole-script lookalikes, hidden characters and full-width letters hold", () => {
  assert.equal(invoice(billTo("ap@meridian-analytics.com", "раураӏ")).rule, "confusable_payee"); // раураӏ
  assert.equal(invoice(billTo("bill​ing@nomad-coffee.co")).rule, "confusable_payee"); // zero-width space
  assert.equal(invoice(billTo("ap@meridian-analytics.com", "ＰayPal Ltd")).rule, "confusable_payee"); // full-width Ｐ
});

test("honest names are not flagged: plain ASCII, accented Latin, a genuine non-Latin name", () => {
  assert.equal(invoice(billTo("wholesale@nomad-coffee.co", "Nomad Coffee Roasters Ltd")).verdict, "allow");
  assert.equal(invoice(billTo("kasse@cafe-mueller.de", "Café Müller GmbH")).verdict, "allow");
  assert.equal(invoice(billTo("info@kofeinya.ru", "Кофейня Номад")).verdict, "allow"); // Кофейня Номад
});

test("hard caps still win over the new holds", () => {
  pay(200);
  assert.equal(pay(250).rule, "amount_cap");
});
