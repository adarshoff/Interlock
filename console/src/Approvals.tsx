import { useEffect, useState } from "react";
import { api } from "./api";

const money = (a: number, c: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: c || "USD" }).format(a);

export default function Approvals() {
  const [rows, setRows] = useState<any[]>([]);
  const [now, setNow] = useState(Date.now());

  const load = () => api.pending().then(setRows).catch(() => {});
  useEffect(() => {
    load();
    const a = setInterval(load, 2000);
    const b = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  const act = async (id: string, go: boolean) => {
    await (go ? api.approve(id) : api.deny(id));
    load();
  };

  return (
    <>
      <h1>Waiting on you</h1>
      <p className="sub">Payments Interlock stopped before they reached PayPal.</p>

      {rows.length === 0 && (
        <div className="empty">Nothing is waiting. Held payments appear here the moment an agent triggers one.</div>
      )}

      {rows.map((t) => {
        const injection = t.injection_json ? JSON.parse(t.injection_json) : null;
        const intent = t.intent_json ? JSON.parse(t.intent_json) : null;
        const left = Math.max(0, 120 - Math.round((now - t.created_at) / 1000));
        return (
          <article className="card" key={t.id}>
            <header className="hd">
              <div>
                <div className="amt">{money(t.amount ?? 0, t.currency)}</div>
                <div className="id">{t.payee ?? "unknown payee"} · {t.tool_name}</div>
              </div>
              <div className="clock">{left}s</div>
            </header>

            <dl>
              <div className="field">
                <dt>You authorised</dt>
                <dd>{t.mandate?.instruction_text}</dd>
              </div>
              <div className="field">
                <dt>Why this stopped</dt>
                <dd>{intent?.reason ?? JSON.parse(t.policy_json).detail ?? t.rule}</dd>
              </div>
              {t.trace?.agent_reasoning && (
                <div className="field">
                  <dt>The agent said</dt>
                  <dd>{t.trace.agent_reasoning}</dd>
                </div>
              )}
            </dl>

            {injection?.injection_detected && (
              <div className="flag">
                <p>The page the agent read contains instructions aimed at the agent, not at you.</p>
                <div className="span">{injection.span}</div>
              </div>
            )}

            <div className="acts">
              <button className="go" onClick={() => act(t.id, true)}>Approve payment</button>
              <button onClick={() => act(t.id, false)}>Decline</button>
            </div>
          </article>
        );
      })}
    </>
  );
}
