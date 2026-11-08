import { useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry } from "ag-grid-community";
import { AllEnterpriseModule, LicenseManager } from "ag-grid-enterprise";

ModuleRegistry.registerModules([AllEnterpriseModule]);
// Trial key from ag-grid.com, or drop this line to run Community with
// grouping and master/detail disabled.
if (import.meta.env.VITE_AG_GRID_KEY) LicenseManager.setLicenseKey(import.meta.env.VITE_AG_GRID_KEY);

const money = (p: any) =>
  p.value == null ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(p.value);

export default function Transactions() {
  const gridRef = useRef<AgGridReact>(null);

  const columnDefs = useMemo(
    () => [
      { field: "id", headerName: "Payment", cellClass: "mono", width: 150, cellRenderer: "agGroupCellRenderer" },
      { field: "created_at", headerName: "When", width: 170,
        valueFormatter: (p: any) => new Date(p.value).toLocaleString() },
      { field: "payee", headerName: "Paid to", flex: 1, enableRowGroup: true },
      { field: "amount", headerName: "Amount", width: 120, cellClass: "mono",
        valueFormatter: money, type: "numericColumn", aggFunc: "sum" },
      { field: "verdict", headerName: "Verdict", width: 110, enableRowGroup: true, rowGroup: false,
        cellClass: (p: any) => `pill v-${p.value}` },
      { field: "rule", headerName: "Rule", width: 150, enableRowGroup: true },
      { field: "resolution", headerName: "Outcome", width: 120 },
      { field: "session_id", headerName: "Agent session", width: 150, cellClass: "mono", enableRowGroup: true },
      { field: "tool_name", headerName: "Tool", width: 150, cellClass: "mono" },
    ],
    []
  );

  // Master/detail: expanding a row shows the full reasoning trace.
  const detailCellRenderer = useMemo(
    () => (p: any) => {
      const gates = (() => {
        try { return JSON.parse(p.data.policy_json); } catch { return {}; }
      })();
      return (
        <pre className="trace">
          {JSON.stringify(
            {
              arguments: JSON.parse(p.data.arguments_json),
              policy: gates,
              intent: p.data.intent_json ? JSON.parse(p.data.intent_json) : null,
              injection: p.data.injection_json ? JSON.parse(p.data.injection_json) : null,
            },
            null,
            2
          )}
        </pre>
      );
    },
    []
  );

  // Server-side row model — the grid pages against SQLite, not the browser.
  const datasource = useMemo(
    () => ({
      getRows: async (params: any) => {
        const offset = params.request.startRow ?? 0;
        const limit = (params.request.endRow ?? 100) - offset;
        const res = await fetch(`/api/transactions?offset=${offset}&limit=${limit}`).then((r) => r.json());
        params.success({ rowData: res.rows, rowCount: res.total });
      },
    }),
    []
  );

  return (
    <>
      <h1>Payments</h1>
      <p className="sub">Every call an agent made, cleared or stopped. Expand a row for the full trace.</p>
      <div className="grid-wrap ag-theme-quartz ag-theme-interlock">
        <AgGridReact
          ref={gridRef}
          columnDefs={columnDefs as any}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          rowModelType="serverSide"
          serverSideDatasource={datasource}
          cacheBlockSize={100}
          masterDetail
          detailCellRenderer={detailCellRenderer}
          detailRowHeight={320}
          rowGroupPanelShow="always"
          sideBar={{ toolPanels: ["columns", "filters"] }}
          getRowId={(p) => p.data.id}
        />
      </div>
    </>
  );
}
