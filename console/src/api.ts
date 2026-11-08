const j = (r: Response) => r.json();

export const api = {
  pending: () => fetch("/api/pending").then(j),
  transactions: (offset = 0, limit = 100, verdict?: string) =>
    fetch(`/api/transactions?offset=${offset}&limit=${limit}${verdict ? `&verdict=${verdict}` : ""}`).then(j),
  approve: (id: string) => fetch(`/api/transactions/${id}/approve`, { method: "POST" }).then(j),
  deny: (id: string) => fetch(`/api/transactions/${id}/deny`, { method: "POST" }).then(j),
  policies: () => fetch("/api/policies").then(j),
  dispute: (id: string) => fetch(`/api/transactions/${id}/dispute`, { method: "POST" }).then(j),
};
