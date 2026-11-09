import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

interface Mandate {
  id: string;
  instruction_text: string;
  amount_cap: number | null;
  cumulative_cap: number | null;
  expires_at: number;
}
interface Tx {
  id: string;
  mandate_id: string;
  tool_name: string;
  arguments_json: string;
  amount: number | null;
  currency: string | null;
  payee: string | null;
  verdict: "allow" | "hold" | "block";
  rule: string | null;
  policy_json: string;
  intent_json: string | null;
  injection_json: string | null;
  resolution: string | null;
  created_at: number;
}
interface Pending extends Tx {
  mandate?: Mandate;
  trace?: { consumed_content: string | null; agent_reasoning: string | null };
}
interface Intent { aligned: boolean; confidence: number; reason: string; concerns: string[] }
interface Injection { injection_detected: boolean; confidence: number; technique: string | null; span: string | null }

/** Must match HOLD_TIMEOUT_MS on the server; set VITE_HOLD_TIMEOUT_MS if you change it there. */
const HOLD_TIMEOUT_MS = Number((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_HOLD_TIMEOUT_MS ?? 120_000);
const URGENT_MS = 30_000;
const HISTORY_ROWS = 300;

const parse = <T,>(s: string | null | undefined): T | null => {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};
const money = (a: number | null | undefined, c?: string | null) =>
  a == null ? "Amount unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: c || "USD" }).format(a);
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`);
const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The server does not parse invoice lines into an amount yet, so the card does, for display only. */
function invoiceTotal(args: any): number | null {
  if (!Array.isArray(args?.items)) return null;
  let total = 0;
  for (const it of args.items) {
    const v = Number(it?.unit_amount?.value) * Number(it?.quantity ?? 1);
    if (!Number.isFinite(v)) return null;
    total += v * (1 + Number(it?.tax?.percent ?? 0) / 100);
  }
  return Math.round((total + Number(args.shipping_cost ?? 0)) * 100) / 100;
}

function who(t: Tx, args: any): { label: string; value: string; prose?: boolean } {
  if (t.payee) return { label: "to", value: t.payee };
  if (t.tool_name === "create_invoice") {
    const r = args?.primary_recipients?.[0]?.billing_info;
    if (r?.email_address || r?.business_name) return { label: "billed to", value: r.email_address ?? r.business_name };
  }
  if (t.tool_name === "send_invoice") {
    const extra: string[] = args?.additional_recipients ?? [];
    return { label: "sending invoice", value: `${args?.invoice_id ?? "?"}${extra.length ? ` → ${extra.join(", ")}` : ""}` };
  }
  if (t.tool_name === "create_order") return { label: "to", value: "your own PayPal merchant account", prose: true };
  return { label: "to", value: "unknown payee", prose: true };
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const RULES: Record<string, { label: string; glyph: string; tone: string; headline: string }> = {
  split_payment:    { label: "Split payment",       glyph: "⫽", tone: "split",  headline: "This looks like one purchase broken into smaller payments to get under your cap." },
  after_refusal:    { label: "Retry after refusal", glyph: "↻", tone: "retry",  headline: "The agent tried to pay again straight after a payment was refused." },
  confusable_payee: { label: "Lookalike payee",     glyph: "Аа", tone: "spoof", headline: "The payee is spelled with lookalike characters. It imitates a name you would trust." },
  prompt_injection: { label: "Prompt injection",    glyph: "⚠", tone: "inject", headline: "A page the agent read contained hidden instructions aimed at the agent, not you." },
  intent_drift:     { label: "Off-mandate",         glyph: "↗", tone: "drift",  headline: "" },
  gate_error:       { label: "Check unavailable",   glyph: "?", tone: "muted",  headline: "" },
  new_payee:        { label: "New payee",           glyph: "+", tone: "info",   headline: "" },
  velocity:         { label: "Too many payments",   glyph: "≋", tone: "info",   headline: "" },
};
const ruleMeta = (r: string) => RULES[r] ?? { label: r.replace(/_/g, " "), glyph: "•", tone: "info", headline: "" };

/** Every reason this payment stopped, most specific first. Intent can overwrite the policy rule on the row. */
function reasonsFor(t: Pending, policyRule: string | null, intent: Intent | null, injection: Injection | null): string[] {
  const out: string[] = [];
  const add = (r: string | null | undefined) => r && !out.includes(r) && out.push(r);
  if (injection?.injection_detected) add("prompt_injection");
  add(policyRule);
  if (t.rule === "intent_drift" && intent?.concerns?.includes("gate_error")) add("gate_error");
  else add(t.rule);
  return out;
}

/* ------------------------------------------------------------------ */
/* Lookalike characters                                                */
/* ------------------------------------------------------------------ */

const SCRIPTS: Array<[string, RegExp]> = [
  ["Latin", /\p{Script=Latin}/u], ["Cyrillic", /\p{Script=Cyrillic}/u], ["Greek", /\p{Script=Greek}/u],
  ["Armenian", /\p{Script=Armenian}/u], ["Cherokee", /\p{Script=Cherokee}/u],
];
const scriptOf = (ch: string) => SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? (/\p{L}/u.test(ch) ? "other script" : null);
const INVISIBLE = /[\p{Cf}͏ᅟᅠㅤﾠ]/u;
const cp = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

function suspicious(ch: string, kind: "email" | "name") {
  if (INVISIBLE.test(ch)) return true;
  if (kind === "email") return ch < " " || ch > "~";
  if (ch.normalize("NFKC") !== ch) return true;
  const s = scriptOf(ch);
  return s !== null && s !== "Latin";
}

/** Parses policy.ts's confusable_payee detail: field "value" reason. It can look identical to "skeleton". */
function parseConfusable(detail: string | null) {
  const m = detail?.match(/^(\S+) "([\s\S]*?)" (?:contains|mixes|is written)[\s\S]*?It can look identical to "([\s\S]*)"\.$/);
  if (!m) return null;
  const [, field, value, looksLike] = m;
  const kind: "email" | "name" = /email|recipients\[\d+\]$/.test(field) || value.includes("@") ? "email" : "name";
  return { field, value, looksLike, kind };
}

/** The Latin letter a suspicious character stands in for, by position in the server's skeleton. */
function lookalikeOf(ch: string, value: string, looksLike: string) {
  const visible = [...value].filter((c) => !INVISIBLE.test(c));
  return [...looksLike][visible.indexOf(ch)] ?? "?";
}

function Lookalike({ value, kind, labels = true }: { value: string; kind: "email" | "name"; labels?: boolean }) {
  return (
    <span className="ap-look">
      {[...value].map((ch, i) =>
        suspicious(ch, kind) ? (
          <mark key={i} className="ap-glyph" title={`${cp(ch)} ${scriptOf(ch) ?? "invisible"}`}>
            {INVISIBLE.test(ch) ? "␣" : ch}
            {labels && <span className="ap-glyph-cp">{cp(ch)}</span>}
          </mark>
        ) : (
          <Fragment key={i}>{ch}</Fragment>
        )
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function RuleBadge({ rule, primary }: { rule: string; primary: boolean }) {
  const m = ruleMeta(rule);
  return (
    <span className={`ap-badge ap-t-${m.tone}${primary ? "" : " ap-badge-2"}`}>
      <span className="ap-badge-glyph" aria-hidden>{m.glyph}</span>
      <span className="ap-badge-label">{m.label}</span>
      <span className="ap-badge-code">{rule}</span>
    </span>
  );
}

function Countdown({ createdAt, now }: { createdAt: number; now: number }) {
  const left = Math.max(0, createdAt + HOLD_TIMEOUT_MS - now);
  const frac = left / HOLD_TIMEOUT_MS;
  const r = 19, c = 2 * Math.PI * r;
  const state = left === 0 ? "out" : left < URGENT_MS ? "urgent" : "ok";
  return (
    <div className={`ap-clock ap-clock-${state}`} role="timer" aria-label={`${Math.ceil(left / 1000)} seconds until this payment is refused automatically`}>
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden>
        <circle cx="24" cy="24" r={r} className="ap-ring-bg" />
        <circle cx="24" cy="24" r={r} className="ap-ring" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 24 24)" />
      </svg>
      <div className="ap-clock-text">
        <div className="ap-clock-num">{left === 0 ? "0:00" : clock(left)}</div>
        <div className="ap-clock-sub">{left === 0 ? "refusing…" : "auto-declines"}</div>
      </div>
    </div>
  );
}

function SplitPanel({ t, history, amount }: { t: Pending; history: Tx[]; amount: number | null }) {
  const cap = t.mandate?.amount_cap ?? null;
  const detail = parse<{ detail: string }>(t.policy_json)?.detail ?? "";
  const windowMin = Number(detail.match(/in the last ([\d.]+) minutes/)?.[1] ?? 10);
  const earlier = history
    .filter((h) => h.id !== t.id && h.mandate_id === t.mandate_id && (h.payee ?? null) === (t.payee ?? null)
      && h.created_at < t.created_at && h.created_at > t.created_at - windowMin * 60_000
      && h.verdict !== "block" && (h.resolution == null || h.resolution === "auto" || h.resolution === "approved"))
    .sort((a, b) => a.created_at - b.created_at);
  if (!earlier.length) return <p className="ap-detail">{detail}</p>;

  const parts = [...earlier.map((h) => ({ tx: h, amount: h.amount ?? 0, current: false })), { tx: t as Tx, amount: amount ?? 0, current: true }];
  const total = parts.reduce((s, p) => s + p.amount, 0);
  const scale = Math.max(total, cap ?? 0) * 1.08 || 1;
  const status = (h: Tx) => (h.resolution === "auto" ? "went through" : h.resolution === "approved" ? "you approved" : "waiting");

  return (
    <div className="ap-panel">
      <div className="ap-panel-title">Payments to {t.payee ?? "this merchant"} in the last {windowMin} minutes</div>
      <ol className="ap-rows">
        {parts.map((p) => (
          <li key={p.tx.id} className={p.current ? "ap-row-now" : ""}>
            <span className="ap-row-when">{p.current ? "now" : `${ago(t.created_at - p.tx.created_at)} before`}</span>
            <span className="ap-row-amt">{money(p.amount, t.currency)}</span>
            <span className="ap-row-what">{p.current ? "this payment, held" : status(p.tx)}</span>
          </li>
        ))}
      </ol>
      <div className="ap-bar" aria-hidden>
        {parts.map((p, i) => (
          <div key={p.tx.id} className={`ap-seg${p.current ? " ap-seg-now" : ""}`} style={{ width: `${(p.amount / scale) * 100}%` }}>
            <span>{money(p.amount, t.currency)}</span>
            {i < parts.length - 1 && <i />}
          </div>
        ))}
        {cap != null && (
          <div className="ap-cap" style={{ left: `${(cap / scale) * 100}%` }}>
            <span>cap {money(cap, t.currency)}</span>
          </div>
        )}
      </div>
      <div className="ap-sum">
        Together <strong>{money(total, t.currency)}</strong>
        {cap != null && total > cap && <> · <span className="ap-over">{money(total - cap, t.currency)} over</span> the {money(cap, t.currency)} single-payment cap</>}
      </div>
    </div>
  );
}

function RetryPanel({ t, history, amount }: { t: Pending; history: Tx[]; amount: number | null }) {
  const refused = history
    .filter((h) => h.id !== t.id && h.mandate_id === t.mandate_id && h.created_at < t.created_at
      && (h.verdict === "block" || h.resolution === "denied" || h.resolution === "timeout"))
    .sort((a, b) => b.created_at - a.created_at)[0];
  const detail = parse<{ detail: string }>(t.policy_json)?.detail ?? "";
  if (!refused) return <p className="ap-detail">{detail}</p>;
  const why = parse<{ detail: string | null }>(refused.policy_json)?.detail;
  const how = refused.verdict === "block" ? `Blocked · ${refused.rule ?? "policy"}` : refused.resolution === "denied" ? "You declined it" : "Timed out unapproved";
  const refusedAmount = refused.amount ?? invoiceTotal(parse(refused.arguments_json));

  return (
    <div className="ap-panel">
      <div className="ap-panel-title">What was refused just before</div>
      <div className="ap-timeline">
        <div className="ap-tl-item ap-tl-refused">
          <div className="ap-tl-amt">{money(refusedAmount, refused.currency)}</div>
          <div className="ap-tl-meta">{refused.tool_name}{refused.payee ? ` → ${refused.payee}` : ""}</div>
          <div className="ap-tl-how">{how}</div>
          {why && <div className="ap-tl-why">{why}</div>}
        </div>
        <div className="ap-tl-gap">{ago(t.created_at - refused.created_at)} later</div>
        <div className="ap-tl-item ap-tl-now">
          <div className="ap-tl-amt">{money(amount, t.currency)}</div>
          <div className="ap-tl-meta">{t.tool_name}{t.payee ? ` → ${t.payee}` : ""}</div>
          <div className="ap-tl-how">This payment, held</div>
        </div>
      </div>
    </div>
  );
}

function ConfusablePanel({ t }: { t: Pending }) {
  const c = parseConfusable(parse<{ detail: string }>(t.policy_json)?.detail ?? null);
  if (!c) return <p className="ap-detail">{parse<{ detail: string }>(t.policy_json)?.detail}</p>;
  const odd = [...new Set([...c.value].filter((ch) => suspicious(ch, c.kind)))];
  return (
    <div className="ap-panel">
      <div className="ap-panel-title">The agent is about to use <code>{c.field}</code></div>
      <div className="ap-spoof">
        <div className="ap-spoof-row">
          <span className="ap-spoof-k">Actually is</span>
          <span className="ap-spoof-v"><Lookalike value={c.value} kind={c.kind} /></span>
        </div>
        <div className="ap-spoof-row">
          <span className="ap-spoof-k">Pretends to be</span>
          <span className="ap-spoof-v ap-spoof-real">{c.looksLike}</span>
        </div>
      </div>
      <ul className="ap-chars">
        {odd.map((ch) => (
          <li key={ch}>
            <span className="ap-chars-ch">{INVISIBLE.test(ch) ? "␣" : ch}</span>
            <code>{cp(ch)}</code>
            <span>{INVISIBLE.test(ch) ? "invisible character, takes up no space" : `${scriptOf(ch) ?? "unknown"} letter`}</span>
            {!INVISIBLE.test(ch) && <span className="ap-chars-not">not a Latin “{lookalikeOf(ch, c.value, c.looksLike)}”</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Argument values the agent is about to send that repeat text from the injected span: proof it took the bait. */
function echoesOf(args: unknown, span: string | null): Array<{ path: string; value: string }> {
  const norm = (s: string) => s.replace(/[“”"']/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const hay = norm(span ?? "");
  const out: Array<{ path: string; value: string }> = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") { if (hay && v.length >= 16 && hay.includes(norm(v))) out.push({ path, value: v }); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(args, "");
  return out;
}

function InjectionPanel({ t, injection }: { t: Pending; injection: Injection }) {
  const echoes = useMemo(() => echoesOf(parse(t.arguments_json), injection.span), [t.arguments_json, injection.span]);
  const source = useMemo(() => {
    const content = t.trace?.consumed_content ?? "";
    const probe = (injection.span ?? "").slice(0, 40);
    let url: string | null = null;
    for (const m of content.matchAll(/^--- (.+?) ---$/gm)) {
      const section = content.slice(m.index! + m[0].length).split(/^--- .+? ---$/m)[0];
      if (!probe || section.includes(probe)) { url = m[1]; if (probe) break; }
    }
    return url;
  }, [t.trace?.consumed_content, injection.span]);

  return (
    <div className="ap-quarantine">
      <div className="ap-q-head">
        <span>Untrusted text from {source ? <code>{source}</code> : "a page the agent read"}</span>
        <span className="ap-q-meta">{injection.technique ?? "injection"} · {Math.round(injection.confidence * 100)}% sure</span>
      </div>
      <pre className="ap-q-body">{injection.span || "(the scanner flagged this page but returned no excerpt)"}</pre>
      <div className="ap-q-foot">Shown exactly as written on the page. It is evidence, not an instruction to you.</div>
      {echoes.length > 0 && (
        <div className="ap-echo">
          <div className="ap-echo-head">The agent already followed it. This payment carries the page’s words:</div>
          {echoes.map((e) => (
            <div key={e.path} className="ap-echo-row"><code>{e.path}</code><span>{e.value}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

function Card({ t, now, history, onDone }: { t: Pending; now: number; history: Tx[]; onDone: (id: string) => void }) {
  const [busy, setBusy] = useState<null | "approve" | "deny">(null);
  const [note, setNote] = useState<string | null>(null);
  const args = useMemo(() => parse<any>(t.arguments_json) ?? {}, [t.arguments_json]);
  const policy = parse<{ rule: string | null; detail: string | null }>(t.policy_json);
  const intent = parse<Intent>(t.intent_json);
  const injection = parse<Injection>(t.injection_json);
  const reasons = reasonsFor(t, policy?.rule ?? null, intent, injection);
  const primary = reasons[0] ?? t.rule ?? "hold";
  const derived = t.amount == null && t.tool_name === "create_invoice" ? invoiceTotal(args) : null;
  const amount = t.amount ?? derived;
  const payee = who(t, args);
  const confusable = reasons.includes("confusable_payee") ? parseConfusable(policy?.detail ?? null) : null;
  const m = t.mandate;

  const headline =
    ruleMeta(primary).headline ||
    (primary === "intent_drift" || primary === "gate_error" ? intent?.reason : null) ||
    policy?.detail ||
    "Held for your review.";

  const act = async (go: boolean) => {
    setBusy(go ? "approve" : "deny");
    const r = await (go ? api.approve(t.id) : api.deny(t.id)).catch(() => ({ ok: false, note: "Could not reach Interlock." }));
    if (r?.ok) onDone(t.id);
    else { setNote(r?.note ?? "That payment is no longer waiting."); setBusy(null); }
  };

  return (
    <article className={`ap-card ap-t-${ruleMeta(primary).tone}`} aria-label={`${ruleMeta(primary).label}: ${money(amount, t.currency)}`}>
      <div className="ap-top">
        <div className="ap-badges">
          {reasons.map((r, i) => <RuleBadge key={r} rule={r} primary={i === 0} />)}
        </div>
        <Countdown createdAt={t.created_at} now={now} />
      </div>

      <header className="ap-head">
        <div className="ap-amt">
          {money(amount, t.currency)}
          {derived != null && <span className="ap-amt-note">from invoice lines</span>}
        </div>
        <div className="ap-payee">
          <span className="ap-payee-k">{payee.label}</span>{" "}
          {confusable && payee.value === confusable.value
            ? <Lookalike value={payee.value} kind={confusable.kind} labels={false} />
            : <span className={payee.prose ? "ap-payee-prose" : "ap-payee-v"}>{payee.value}</span>}
          <span className="ap-tool">{t.tool_name}</span>
        </div>
      </header>

      <section className="ap-sec">
        <h3>You authorised</h3>
        <p className="ap-mandate">“{m?.instruction_text ?? "No mandate on record"}”</p>
        {m && (
          <p className="ap-caps">
            {m.amount_cap != null && <span>up to <strong>{money(m.amount_cap, t.currency)}</strong> per payment</span>}
            {m.cumulative_cap != null && <span>up to <strong>{money(m.cumulative_cap, t.currency)}</strong> in total</span>}
          </p>
        )}
      </section>

      <section className="ap-sec">
        <h3>Why this stopped</h3>
        <p className="ap-why">{headline}</p>
      </section>

      <section className="ap-sec ap-sec-detail">
        {reasons.includes("split_payment") && <SplitPanel t={t} history={history} amount={amount} />}
        {reasons.includes("after_refusal") && <RetryPanel t={t} history={history} amount={amount} />}
        {reasons.includes("confusable_payee") && <ConfusablePanel t={t} />}
        {injection?.injection_detected && <InjectionPanel t={t} injection={injection} />}
        {(reasons.includes("intent_drift") || reasons.includes("gate_error")) && intent && primary !== "intent_drift" && primary !== "gate_error" && (
          <p className="ap-detail"><strong>The intent check also flagged it:</strong> {intent.reason}</p>
        )}
        {intent?.concerns?.length && !intent.aligned ? (
          <ul className="ap-concerns">{intent.concerns.filter((x) => x !== "gate_error").map((x) => <li key={x}>{x.replace(/_/g, " ")}</li>)}</ul>
        ) : null}
        {!["split_payment", "after_refusal", "confusable_payee", "prompt_injection", "intent_drift", "gate_error"].some((r) => reasons.includes(r)) && policy?.detail && (
          <p className="ap-detail">{policy.detail}</p>
        )}
        {t.trace?.agent_reasoning && (
          <p className="ap-agent"><span>The agent said</span> {t.trace.agent_reasoning}</p>
        )}
      </section>

      {note && <p className="ap-note">{note}</p>}
      <div className="ap-acts">
        <button className="ap-approve" disabled={!!busy} onClick={() => act(true)}>
          {busy === "approve" ? "Approving…" : `Approve ${money(amount, t.currency)}`}
        </button>
        <button className="ap-deny" disabled={!!busy} onClick={() => act(false)}>
          {busy === "deny" ? "Declining…" : "Decline"}
        </button>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

export default function Approvals() {
  const [rows, setRows] = useState<Pending[]>([]);
  const [history, setHistory] = useState<Tx[]>([]);
  const [now, setNow] = useState(Date.now());
  const done = useRef(new Set<string>());

  const needsHistory = rows.some((r) => {
    const rule = parse<{ rule: string | null }>(r.policy_json)?.rule;
    return rule === "split_payment" || rule === "after_refusal";
  });

  useEffect(() => {
    const load = () =>
      api.pending().then((r: Pending[]) => setRows(r.filter((x) => !done.current.has(x.id)))).catch(() => {});
    load();
    const a = setInterval(load, 2000);
    const b = setInterval(() => setNow(Date.now()), 250);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  useEffect(() => {
    if (!needsHistory) return;
    const load = () => api.transactions(0, HISTORY_ROWS).then((r: { rows: Tx[] }) => setHistory(r.rows)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [needsHistory]);

  const onDone = (id: string) => {
    done.current.add(id);
    setRows((r) => r.filter((x) => x.id !== id));
  };

  return (
    <>
      <style>{CSS}</style>
      <h1>Waiting on you</h1>
      <p className="sub">Payments Interlock stopped before they reached PayPal. Nothing moves until you decide.</p>

      {rows.length === 0 && (
        <div className="empty">Nothing is waiting. Held payments appear here the moment an agent triggers one.</div>
      )}
      <div className="ap-list">
        {rows.map((t) => <Card key={t.id} t={t} now={now} history={history} onDone={onDone} />)}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Styles (scoped by the ap- prefix; tokens come from styles.css)      */
/* ------------------------------------------------------------------ */

const CSS = `
.ap-list { display: grid; gap: 18px; max-width: 780px; }
.ap-card { --tone: var(--hold); --tone-bg: rgba(213,154,60,.10);
  position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  padding: 20px 24px 22px; box-shadow: inset 3px 0 0 var(--tone); animation: ap-in .25s ease-out; }
@keyframes ap-in { from { opacity: 0; transform: translateY(6px); } }

.ap-t-split  { --tone: #e0913a; --tone-bg: rgba(224,145,58,.12); }
.ap-t-retry  { --tone: #a98bf0; --tone-bg: rgba(169,139,240,.12); }
.ap-t-spoof  { --tone: #e86fb2; --tone-bg: rgba(232,111,178,.12); }
.ap-t-inject { --tone: #ef5b55; --tone-bg: rgba(239,91,85,.13); }
.ap-t-drift  { --tone: #5aa7e6; --tone-bg: rgba(90,167,230,.12); }
.ap-t-info   { --tone: #58b8b0; --tone-bg: rgba(88,184,176,.12); }
.ap-t-muted  { --tone: #8a93a3; --tone-bg: rgba(138,147,163,.12); }

.ap-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
.ap-badges { display: flex; flex-wrap: wrap; gap: 8px; }
.ap-badge { display: inline-flex; align-items: center; gap: 8px; padding: 5px 11px 5px 6px; border-radius: 999px;
  background: var(--tone-bg); color: var(--tone); border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent); }
.ap-badge-glyph { display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 4px; border-radius: 999px;
  background: var(--tone); color: #0e1116; font-weight: 700; font-size: 12px; }
.ap-badge-label { font-weight: 600; font-size: 13px; letter-spacing: .01em; }
.ap-badge-code { font-family: var(--mono); font-size: 11.5px; opacity: .75; }
.ap-badge-2 { filter: saturate(.75); opacity: .9; }
.ap-badge-2 .ap-badge-glyph { background: transparent; color: var(--tone); border: 1px solid var(--tone); }

.ap-clock { display: flex; align-items: center; gap: 8px; flex: none; }
.ap-ring-bg { fill: none; stroke: var(--line); stroke-width: 4; }
.ap-ring { fill: none; stroke: var(--hold); stroke-width: 4; stroke-linecap: round; transition: stroke-dashoffset .25s linear, stroke .3s; }
.ap-clock-text { line-height: 1.1; }
.ap-clock-num { font-family: var(--mono); font-size: 18px; color: var(--text); font-variant-numeric: tabular-nums; }
.ap-clock-sub { font-size: 11px; color: var(--muted); }
.ap-clock-urgent .ap-ring { stroke: var(--block); }
.ap-clock-urgent .ap-clock-num { color: var(--block); animation: ap-pulse 1s ease-in-out infinite; }
.ap-clock-out .ap-clock-num { color: var(--muted); }
@keyframes ap-pulse { 50% { opacity: .45; } }

.ap-head { padding-bottom: 14px; }
.ap-amt { font-family: var(--mono); font-size: 34px; font-weight: 500; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.ap-amt-note { font-family: var(--sans); font-size: 12px; color: var(--muted); margin-left: 10px; letter-spacing: 0; }
.ap-payee { margin-top: 4px; font-size: 15px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.ap-payee-k { color: var(--muted); }
.ap-payee-v, .ap-payee .ap-look { font-family: var(--mono); color: var(--text); }
.ap-tool { font-family: var(--mono); font-size: 11.5px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; margin-left: 4px; }

.ap-sec { border-top: 1px solid var(--line); padding: 12px 0; }
.ap-sec h3 { margin: 0 0 4px; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
.ap-mandate { margin: 0; font-size: 15px; }
.ap-caps { margin: 6px 0 0; display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }
.ap-caps strong { font-family: var(--mono); font-weight: 500; color: var(--text); }
.ap-payee-prose { color: var(--text); }
.ap-why { margin: 0; font-size: 15px; font-weight: 500; color: var(--text); }
.ap-sec-detail { display: grid; gap: 12px; }
.ap-detail { margin: 0; color: var(--text); }

.ap-panel { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.ap-panel-title { font-size: 12.5px; color: var(--muted); margin-bottom: 10px; }
.ap-panel code { font-family: var(--mono); color: var(--text); }

.ap-rows { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 4px; }
.ap-rows li { display: grid; grid-template-columns: 110px 110px 1fr; gap: 10px; font-size: 13.5px; padding: 5px 8px; border-radius: 5px; }
.ap-row-when { color: var(--muted); font-family: var(--mono); font-size: 12.5px; }
.ap-row-amt { font-family: var(--mono); text-align: right; }
.ap-row-what { color: var(--muted); }
.ap-row-now { background: var(--tone-bg); }
.ap-row-now .ap-row-what, .ap-row-now .ap-row-when { color: var(--tone); }

.ap-bar { position: relative; display: flex; height: 30px; border-radius: 5px; background: var(--raised); margin: 34px 0 10px; }
.ap-seg { position: relative; height: 100%; background: #3b4352; display: flex; align-items: center; justify-content: center; overflow: visible; }
.ap-seg:first-child { border-radius: 5px 0 0 5px; }
.ap-seg span { font-family: var(--mono); font-size: 11.5px; color: var(--text); white-space: nowrap; }
.ap-seg i { position: absolute; right: 0; top: 4px; bottom: 4px; width: 2px; background: var(--surface); }
.ap-seg-now { background: repeating-linear-gradient(135deg, var(--tone) 0 6px, color-mix(in srgb, var(--tone) 70%, black) 6px 12px); border-radius: 0 5px 5px 0; }
.ap-seg-now span { color: #0e1116; font-weight: 600; background: var(--tone); padding: 1px 6px; border-radius: 3px; }
.ap-cap { position: absolute; top: -8px; bottom: -8px; width: 0; border-left: 2px dashed var(--block); }
.ap-cap span { position: absolute; top: -18px; left: -2px; transform: translateX(-50%); font-family: var(--mono); font-size: 11px; color: var(--block); white-space: nowrap; }
.ap-sum { font-size: 14px; }
.ap-sum strong { font-family: var(--mono); }
.ap-over { color: var(--block); font-family: var(--mono); font-weight: 600; }

.ap-timeline { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; }
.ap-tl-item { border: 1px solid var(--line); border-radius: 7px; padding: 10px 12px; background: var(--surface); }
.ap-tl-refused { border-color: color-mix(in srgb, var(--block) 55%, transparent); }
.ap-tl-now { border-color: var(--tone); background: var(--tone-bg); }
.ap-tl-amt { font-family: var(--mono); font-size: 19px; }
.ap-tl-refused .ap-tl-amt { text-decoration: line-through; text-decoration-color: var(--block); color: var(--muted); }
.ap-tl-meta { font-family: var(--mono); font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.ap-tl-how { font-size: 12.5px; margin-top: 6px; font-weight: 600; }
.ap-tl-refused .ap-tl-how { color: var(--block); }
.ap-tl-now .ap-tl-how { color: var(--tone); }
.ap-tl-why { font-size: 12px; color: var(--muted); margin-top: 3px; }
.ap-tl-gap { font-family: var(--mono); font-size: 12px; color: var(--muted); text-align: center; }
.ap-tl-gap::after { content: "→"; display: block; font-size: 18px; color: var(--tone); }

.ap-spoof { display: grid; gap: 8px; margin-bottom: 12px; }
.ap-spoof-row { display: grid; grid-template-columns: 112px 1fr; align-items: baseline; gap: 10px; }
.ap-spoof-k { font-size: 12px; color: var(--muted); }
.ap-spoof-v { font-family: var(--mono); font-size: 21px; word-break: break-all; }
.ap-spoof-real { color: var(--muted); font-size: 16px; }
.ap-look { white-space: pre-wrap; }
.ap-glyph { position: relative; display: inline; background: var(--tone-bg); color: var(--tone); border-radius: 2px;
  box-shadow: 0 0 0 1.5px var(--tone); font-weight: 700; }
.ap-glyph-cp { position: absolute; left: 50%; top: calc(100% + 5px); transform: translateX(-50%); font-family: var(--mono);
  font-size: 10px; font-weight: 500; line-height: 1; color: #0e1116; background: var(--tone); padding: 2px 4px; border-radius: 3px; white-space: nowrap; }
.ap-glyph-cp::before { content: ""; position: absolute; left: 50%; top: -4px; transform: translateX(-50%);
  border: 4px solid transparent; border-top: 0; border-bottom-color: var(--tone); }
.ap-spoof-row:first-child { padding-bottom: 22px; }
.ap-chars { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.ap-chars li { display: flex; gap: 12px; align-items: baseline; font-size: 13px; }
.ap-chars-ch { font-family: var(--mono); font-size: 18px; color: var(--tone); min-width: 18px; text-align: center; }
.ap-chars code { font-family: var(--mono); color: var(--text); }
.ap-chars-not { color: var(--muted); }

.ap-quarantine { border-radius: 8px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--block) 60%, transparent);
  background: repeating-linear-gradient(135deg, rgba(239,91,85,.07) 0 10px, transparent 10px 20px), #170f10; }
.ap-q-head { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 9px 14px; font-size: 12.5px;
  background: rgba(239,91,85,.14); color: #f2a19d; border-bottom: 1px solid color-mix(in srgb, var(--block) 45%, transparent); }
.ap-q-head code { font-family: var(--mono); color: #ffd2cf; }
.ap-q-meta { font-family: var(--mono); font-size: 11.5px; opacity: .85; }
.ap-q-body { margin: 0; padding: 14px 16px; font-family: var(--mono); font-size: 13px; line-height: 1.55; color: #f4c4c0;
  white-space: pre-wrap; word-break: break-word; border-left: 3px solid var(--block); margin: 12px 14px; background: rgba(0,0,0,.35); }
.ap-q-foot { padding: 0 14px 11px; font-size: 11.5px; color: #b98a87; }
.ap-echo { margin: 0 14px 14px; padding: 10px 12px; border-radius: 6px; background: rgba(239,91,85,.16); border: 1px solid var(--block); }
.ap-echo-head { font-weight: 600; font-size: 13px; color: #ffd2cf; margin-bottom: 6px; }
.ap-echo-row { display: grid; grid-template-columns: auto 1fr; gap: 10px; font-size: 13px; align-items: baseline; }
.ap-echo-row code { font-family: var(--mono); font-size: 11.5px; color: #f2a19d; }
.ap-echo-row span { color: var(--text); }

.ap-concerns { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; }
.ap-concerns li { font-size: 12px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.ap-agent { margin: 0; font-size: 13px; color: var(--muted); font-style: italic; }
.ap-agent span { font-style: normal; font-size: 11.5px; text-transform: uppercase; letter-spacing: .07em; margin-right: 6px; }

.ap-note { margin: 10px 0 0; color: var(--block); font-size: 13px; }
.ap-acts { display: flex; gap: 10px; margin-top: 14px; padding-top: 16px; border-top: 1px solid var(--line); }
.ap-acts button { padding: 10px 20px; border-radius: 6px; font-weight: 500; border: 1px solid var(--line); }
.ap-approve { background: var(--allow); border-color: var(--allow) !important; color: #06130d; }
.ap-approve:hover:not(:disabled) { filter: brightness(1.08); }
.ap-deny { background: var(--raised); color: var(--text); }
.ap-deny:hover:not(:disabled) { border-color: var(--muted) !important; }
.ap-acts button:disabled { opacity: .55; cursor: progress; }

@media (max-width: 640px) {
  .ap-card { padding: 16px; }
  .ap-timeline { grid-template-columns: 1fr; }
  .ap-tl-gap::after { content: "↓"; }
  .ap-rows li { grid-template-columns: 90px 90px 1fr; }
  .ap-spoof-row { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .ap-card, .ap-clock-urgent .ap-clock-num { animation: none; }
  .ap-ring { transition: none; }
}
`;
