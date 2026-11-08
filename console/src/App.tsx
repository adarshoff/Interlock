import { useEffect, useState } from "react";
import Approvals from "./Approvals";
import Transactions from "./Transactions";
import { api } from "./api";

type View = "approvals" | "transactions";

export default function App() {
  const [view, setView] = useState<View>("approvals");
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    const tick = () => api.pending().then((r) => setWaiting(r.length)).catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand">interlock</div>
        <button data-on={view === "approvals"} onClick={() => setView("approvals")}>
          Waiting on you {waiting > 0 && <span className="count">{waiting}</span>}
        </button>
        <button data-on={view === "transactions"} onClick={() => setView("transactions")}>
          Payments
        </button>
      </nav>
      <main>{view === "approvals" ? <Approvals /> : <Transactions />}</main>
    </div>
  );
}
