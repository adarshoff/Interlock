import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.INTERLOCK_DB = ":memory:";
process.env.SPLIT_PAYMENT_ACTION = "hold";
process.env.SPLIT_PAYMENT_WINDOW_MINUTES = "10";
process.env.AFTER_REFUSAL_ACTION = "hold";
process.env.AFTER_REFUSAL_WINDOW_MINUTES = "10";
process.env.CONFUSABLE_PAYEE_ACTION = "hold";

const { db, q } = await import("../src/db.js");
const { evaluatePolicy } = await import("../src/policy.js");
const { extractPayment, invoiceTotal, resolveSendInvoice } = await import("../src/interceptor.js");
import type { Mandate, Payment, PolicyResult } from "../src/types.js";

let mandate: Mandate;
let seq = 0;

beforeEach(() => {
  db.exec("DELETE FROM transactions; DELETE FROM policies; DELETE FROM mandates;");
  mandate = {
    id: `mdt_inv_${++seq}`, user_id: "user_1",
    instruction_text: "Invoice our wholesale customers for this month's coffee orders.",
    amount_cap: 200, cumulative_cap: 600, categories: null,
    expires_at: Date.now() + 86_400_000, status: "active", created_at: Date.now(),
  } as Mandate;
});

const line = (qty: string, value: string, extra: Record<string, unknown> = {}) =>
  ({ name: "House espresso blend, 10kg", quantity: qty, unit_amount: { currency_code: "USD", value }, ...extra });
const createInvoice = (to: string, items: unknown[], extra: Record<string, unknown> = {}) => ({
  currency_code: "USD",
  primary_recipients: [{ billing_info: { email_address: to } }],
  items, ...extra,
});
const allow = (...emails: string[]) => emails.forEach((value, i) =>
  q.insertPolicy.run({ id: `pol_${seq}_${i}`, mandate_id: mandate.id, rule_type: "merchant_allow", value, source: "user", created_at: Date.now() }));

/** Evaluate and record exactly as interceptor.ts does. */
function run(payment: Payment): PolicyResult {
  const result = evaluatePolicy(mandate, payment);
  const now = Date.now();
  q.insertTx.run({
    id: `tx_${++seq}`, session_id: "ses_test", mandate_id: mandate.id, tool_name: payment.tool,
    arguments_json: JSON.stringify(payment.raw), amount: payment.amount, currency: payment.currency, payee: payment.payee,
    verdict: result.verdict, rule: result.rule, policy_json: JSON.stringify(result),
    intent_json: null, injection_json: null,
    resolution: result.verdict === "allow" ? "auto" : null,
    created_at: now, resolved_at: result.verdict === "allow" ? now : null,
  });
  return result;
}
const paypalInvoice = (value: string, to = "ap@meridian-analytics.com") => async () => ({
  id: "INV2-TEST", status: "DRAFT",
  amount: { currency_code: "USD", value },
  primary_recipients: [{ billing_info: { email_address: to } }],
});

/* ---------- parsing ---------- */

test("invoice total: quantity x unit_amount, as on attack page 04 (2 x 96.00)", () => {
  assert.equal(invoiceTotal([line("2", "96.00")]), 192);
});

test("invoice total: per-line discount (percent or amount), tax on the discounted amount, then shipping", () => {
  const items = [
    line("3", "100.00", { discount: { percent: "10" }, tax: { name: "Sales Tax", percent: "8" } }), // (300 - 30) x 1.08 = 291.60
    line("1", "50.00", { discount: { amount: { currency_code: "USD", value: "5.00" } } }),           // 45.00
  ];
  assert.equal(invoiceTotal(items, "12.50"), 349.1);
});

test("an unreadable line makes the total unknown, never smaller", () => {
  assert.equal(invoiceTotal([line("2", "96.00"), line("1", "lots")]), null);
  assert.equal(invoiceTotal([]), null);
});

test("extractPayment reads create_invoice: amount, currency and the billed recipient as payee", () => {
  const p = extractPayment("create_invoice", createInvoice("ap@meridian-analytics.com", [line("12", "168.00")], { currency_code: "GBP" }));
  assert.equal(p.amount, 2016);
  assert.equal(p.currency, "GBP");
  assert.equal(p.payee, "ap@meridian-analytics.com");
});

test("send_invoice takes its amount, currency and recipient from the invoice at PayPal", async () => {
  const p = await resolveSendInvoice(extractPayment("send_invoice", { invoice_id: "INV2-TEST" }), paypalInvoice("250.00"));
  assert.equal(p.amount, 250);
  assert.equal(p.currency, "USD");
  assert.equal(p.payee, "ap@meridian-analytics.com");
});

/* ---------- caps now apply ---------- */

test("single-payment cap blocks an invoice over it (previously the invoice counted as $0)", () => {
  const r = run(extractPayment("create_invoice", createInvoice("ap@meridian-analytics.com", [line("1", "250.00")])));
  assert.equal(r.verdict, "block");
  assert.equal(r.rule, "amount_cap");
  assert.match(r.detail!, /250/);
});

test("the cap counts tax and shipping, not just the line price", () => {
  allow("ap@meridian-analytics.com");
  const r = run(extractPayment("create_invoice",
    createInvoice("ap@meridian-analytics.com", [line("1", "180.00", { tax: { name: "VAT", percent: "10" } })], { shipping_cost: "5.00" })));
  assert.equal(r.rule, "amount_cap", "180 + 10% + 5 = 203, over 200");
});

test("cumulative cap adds invoices up across recipients", () => {
  allow("a@x.com", "b@x.com", "c@x.com", "d@x.com");
  for (const to of ["a@x.com", "b@x.com", "c@x.com"])
    assert.equal(run(extractPayment("create_invoice", createInvoice(to, [line("1", "190.00")]))).verdict, "allow");
  const fourth = run(extractPayment("create_invoice", createInvoice("d@x.com", [line("1", "190.00")])));
  assert.equal(fourth.rule, "cumulative_cap", "570 + 190 = 760, over 600");
});

test("split rule groups invoices by recipient, not all invoices together", () => {
  allow("a@x.com", "b@x.com");
  assert.equal(run(extractPayment("create_invoice", createInvoice("a@x.com", [line("1", "150.00")]))).verdict, "allow");
  assert.equal(run(extractPayment("create_invoice", createInvoice("b@x.com", [line("1", "150.00")]))).verdict, "allow");
  const again = run(extractPayment("create_invoice", createInvoice("a@x.com", [line("1", "100.00")])));
  assert.equal(again.rule, "split_payment", "150 + 100 to the same customer is over the 200 cap");
});

test("send_invoice over the cap is blocked", async () => {
  const p = await resolveSendInvoice(extractPayment("send_invoice", { invoice_id: "INV2-TEST" }), paypalInvoice("250.00"));
  assert.equal(run(p).rule, "amount_cap");
});

test("sending an invoice created through Interlock is not counted twice", async () => {
  allow("ap@meridian-analytics.com");
  assert.equal(run(extractPayment("create_invoice", createInvoice("ap@meridian-analytics.com", [line("1", "150.00")]))).verdict, "allow");
  const send = await resolveSendInvoice(extractPayment("send_invoice", { invoice_id: "INV2-TEST" }), paypalInvoice("150.00"));
  assert.equal(run(send).verdict, "allow", "not split_payment: it is the same $150, not a second payment");
  assert.equal((q.spentSoFar.get(mandate.id) as { total: number }).total, 150, "spend counted once");
});

/* ---------- unknown is not zero ---------- */

test("send_invoice whose invoice cannot be read is held, not treated as $0", async () => {
  const failing = await resolveSendInvoice(extractPayment("send_invoice", { invoice_id: "INV2-GONE" }), async () => { throw new Error("401"); });
  const r = run(failing);
  assert.equal(r.verdict, "hold");
  assert.equal(r.rule, "amount_unknown");

  const errorBody = await resolveSendInvoice(extractPayment("send_invoice", { invoice_id: "INV2-GONE" }),
    async () => ({ ok: false, status: 404, code: "PAYPAL_API_HTTP_ERROR" }));
  assert.equal(run(errorBody).rule, "amount_unknown");
});

test("create_invoice with an unreadable line is held, not treated as $0", () => {
  const r = run(extractPayment("create_invoice", createInvoice("ap@meridian-analytics.com", [line("1", "TBC")])));
  assert.equal(r.rule, "amount_unknown");
});
