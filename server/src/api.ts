import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { cfg, log } from "./config.js";
import { db, q } from "./db.js";
import { resolveHold } from "./holds.js";

export function startApi() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/pending", (_req, res) => {
    const rows = q.pendingTx.all().map((t) => ({
      ...t,
      mandate: q.mandateById.get(t.mandate_id),
      trace: q.traceFor.all(t.id)[0],
    }));
    res.json(rows);
  });

  // Server-side row model for AG Grid: offset, limit, optional verdict filter.
  app.get("/api/transactions", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const offset = Number(req.query.offset ?? 0);
    const verdict = req.query.verdict as string | undefined;
    const where = verdict ? `WHERE verdict = @verdict` : "";
    const rows = db
      .prepare(`SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
      .all({ limit, offset, verdict });
    const total = (db.prepare(`SELECT COUNT(*) n FROM transactions ${where}`).get({ verdict }) as any).n;
    res.json({ rows, total });
  });

  app.get("/api/transactions/:id", (req, res) => {
    const tx = q.txById.get(req.params.id);
    if (!tx) return res.status(404).json({ error: "No transaction with that id." });
    res.json({ ...tx, trace: q.traceFor.all(tx.id)[0], mandate: q.mandateById.get(tx.mandate_id) });
  });

  app.post("/api/transactions/:id/approve", (req, res) => {
    const ok = resolveHold(req.params.id, "approved");
    res.json({ ok, note: ok ? null : "That payment is no longer waiting." });
  });

  app.post("/api/transactions/:id/deny", (req, res) => {
    const ok = resolveHold(req.params.id, "denied");
    res.json({ ok, note: ok ? null : "That payment is no longer waiting." });
  });

  app.get("/api/mandates", (_req, res) => {
    res.json(db.prepare(`SELECT * FROM mandates ORDER BY created_at DESC`).all());
  });

  app.post("/api/mandates", (req, res) => {
    const { instruction_text, amount_cap, cumulative_cap, hours = 24, velocity_per_hour } = req.body;
    const id = `mdt_${nanoid(8)}`;
    db.prepare(`UPDATE mandates SET status='revoked' WHERE status='active'`).run();
    db.prepare(
      `INSERT INTO mandates (id,user_id,instruction_text,amount_cap,cumulative_cap,categories,expires_at,status,created_at)
       VALUES (?,?,?,?,?,?,?,'active',?)`
    ).run(id, "user_1", instruction_text, amount_cap ?? null, cumulative_cap ?? null, null,
          Date.now() + hours * 3_600_000, Date.now());
    if (velocity_per_hour)
      q.insertPolicy.run({ id: `pol_${nanoid(8)}`, mandate_id: id, rule_type: "velocity_per_hour",
                           value: String(velocity_per_hour), source: "user", created_at: Date.now() });
    res.json(q.mandateById.get(id));
  });

  app.get("/api/policies", (_req, res) => {
    res.json(db.prepare(`SELECT * FROM policies ORDER BY created_at DESC`).all());
  });

  // Dispute evidence assembled from the stored trace.
  app.post("/api/transactions/:id/dispute", (req, res) => {
    const tx = q.txById.get(req.params.id);
    if (!tx) return res.status(404).json({ error: "No transaction with that id." });
    const trace = q.traceFor.all(tx.id)[0] as any;
    const pkg = {
      transaction_id: tx.id,
      occurred_at: new Date(tx.created_at).toISOString(),
      amount: `${tx.amount} ${tx.currency}`,
      payee: tx.payee,
      authorised_under: (q.mandateById.get(tx.mandate_id) as any)?.instruction_text,
      agent_reasoning: trace?.agent_reasoning,
      content_agent_read: (trace?.consumed_content ?? "").slice(0, 4000),
      gate_outputs: trace?.gate_outputs ? JSON.parse(trace.gate_outputs) : null,
      approved_by_human: tx.resolution === "approved",
      raw_request: JSON.parse(tx.arguments_json),
    };
    const id = `dsp_${nanoid(8)}`;
    db.prepare(
      `INSERT INTO disputes (id,transaction_id,paypal_dispute_id,evidence_package,status,created_at)
       VALUES (?,?,?,?,?,?)`
    ).run(id, tx.id, null, JSON.stringify(pkg, null, 2), "draft", Date.now());
    res.json({ id, evidence_package: pkg });
  });

  app.get("/api/disputes", (_req, res) => {
    res.json(db.prepare(`SELECT * FROM disputes ORDER BY created_at DESC`).all());
  });

  app.listen(cfg.apiPort, () => log(`console API on http://localhost:${cfg.apiPort}`));
}
