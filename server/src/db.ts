import { DatabaseSync } from "node:sqlite";
import { cfg } from "./config.js";

export const db = new DatabaseSync(cfg.dbPath);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  instruction_text TEXT NOT NULL,
  amount_cap REAL,
  cumulative_cap REAL,
  categories TEXT,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL,
  client_name TEXT,
  started_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  amount REAL,
  currency TEXT,
  payee TEXT,
  verdict TEXT NOT NULL,
  rule TEXT,
  policy_json TEXT NOT NULL,
  intent_json TEXT,
  injection_json TEXT,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

-- Append-only. Never UPDATE this table; the audit trail must not be rewritable.
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  consumed_content TEXT,
  agent_reasoning TEXT,
  gate_outputs TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,          -- 'user' | 'learned'
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  paypal_dispute_id TEXT,
  evidence_package TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_mandate ON transactions(mandate_id);
CREATE INDEX IF NOT EXISTS idx_pol_mandate ON policies(mandate_id);
`);

export const q = {
  activeMandate: db.prepare(
    `SELECT * FROM mandates WHERE status='active' ORDER BY created_at DESC LIMIT 1`
  ),
  mandateById: db.prepare(`SELECT * FROM mandates WHERE id = ?`),

  spentSoFar: db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE mandate_id = ? AND verdict != 'block' AND resolution != 'denied' AND tool_name != 'send_invoice'`
  ),
  countSince: db.prepare(
    `SELECT COUNT(*) AS n FROM transactions WHERE mandate_id = ? AND created_at > ?`
  ),
  seenPayee: db.prepare(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE mandate_id = ? AND payee = ? AND resolution IN ('auto','approved')`
  ),

  // Payments to one payee that went through or may still go through. `IS` so a null payee
  // (create_order, paid to the token's own merchant account) matches other null payees.
  spentToPayeeSince: db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM transactions
     WHERE mandate_id = ? AND payee IS ? AND created_at > ? AND verdict != 'block' AND tool_name != 'send_invoice'
       AND (resolution IS NULL OR resolution IN ('auto','approved'))`
  ),
  lastRefusalSince: db.prepare(
    `SELECT id, created_at, verdict, rule, resolution FROM transactions
     WHERE mandate_id = ? AND created_at > ?
       AND (verdict = 'block' OR resolution IN ('denied','timeout'))
     ORDER BY created_at DESC LIMIT 1`
  ),

  policiesFor: db.prepare(`SELECT * FROM policies WHERE mandate_id = ?`),
  insertPolicy: db.prepare(
    `INSERT INTO policies (id, mandate_id, rule_type, value, source, created_at)
     VALUES (@id, @mandate_id, @rule_type, @value, @source, @created_at)`
  ),

  insertTx: db.prepare(
    `INSERT INTO transactions
     (id, session_id, mandate_id, tool_name, arguments_json, amount, currency, payee,
      verdict, rule, policy_json, intent_json, injection_json, resolution, created_at, resolved_at)
     VALUES
     (@id, @session_id, @mandate_id, @tool_name, @arguments_json, @amount, @currency, @payee,
      @verdict, @rule, @policy_json, @intent_json, @injection_json, @resolution, @created_at, @resolved_at)`
  ),
  resolveTx: db.prepare(
    `UPDATE transactions SET resolution = ?, resolved_at = ? WHERE id = ?`
  ),
  txById: db.prepare(`SELECT * FROM transactions WHERE id = ?`),
  pendingTx: db.prepare(
    `SELECT * FROM transactions WHERE verdict='hold' AND resolution IS NULL ORDER BY created_at ASC`
  ),

  insertTrace: db.prepare(
    `INSERT INTO traces (id, transaction_id, consumed_content, agent_reasoning, gate_outputs, created_at)
     VALUES (@id, @transaction_id, @consumed_content, @agent_reasoning, @gate_outputs, @created_at)`
  ),
  traceFor: db.prepare(`SELECT * FROM traces WHERE transaction_id = ?`),

  insertSession: db.prepare(
    `INSERT OR IGNORE INTO agent_sessions (id, mandate_id, client_name, started_at)
     VALUES (@id, @mandate_id, @client_name, @started_at)`
  ),
};
