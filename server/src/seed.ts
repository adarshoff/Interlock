import { nanoid } from "nanoid";
import { db, q } from "./db.js";

/** A grid holding twelve rows proves nothing. Seed a few thousand. */
const merchants = ["hotel-aurora.com", "citybikes.io", "nomad-coffee.co", "trainline.test",
                   "giftcard-vault.xyz", "dataplan.net", "lunchbox.app"];
const verdicts = ["allow", "allow", "allow", "allow", "hold", "block"] as const;

const mid = `mdt_${nanoid(8)}`;
db.prepare(`UPDATE mandates SET status='revoked' WHERE status='active'`).run();
db.prepare(
  `INSERT INTO mandates (id,user_id,instruction_text,amount_cap,cumulative_cap,categories,expires_at,status,created_at)
   VALUES (?,?,?,?,?,?,?,'active',?)`
).run(mid, "user_1", "Book a hotel near the conference venue, under $200 a night.", 200, 600, null,
      Date.now() + 86_400_000, Date.now());

const insert = db.transaction(() => {
  for (let i = 0; i < 4000; i++) {
    const verdict = verdicts[i % verdicts.length];
    const payee = merchants[i % merchants.length];
    const amount = Math.round((20 + Math.random() * 400) * 100) / 100;
    const at = Date.now() - i * 60_000;
    const id = `tx_${nanoid(10)}`;
    q.insertTx.run({
      id, session_id: `ses_${(i % 40).toString(36)}`, mandate_id: mid,
      tool_name: "create_order",
      arguments_json: JSON.stringify({ purchase_units: [{ amount: { value: amount, currency_code: "USD" }, payee: { email_address: payee } }] }),
      amount, currency: "USD", payee, verdict,
      rule: verdict === "allow" ? null : verdict === "hold" ? "new_payee" : "amount_cap",
      policy_json: JSON.stringify({ verdict, rule: null, detail: null }),
      intent_json: null, injection_json: null,
      resolution: verdict === "allow" ? "auto" : verdict === "hold" ? "approved" : null,
      created_at: at, resolved_at: verdict === "block" ? null : at + 2000,
    });
  }
});
insert();
console.log(`seeded 4000 transactions under mandate ${mid}`);
