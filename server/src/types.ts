export type Verdict = "allow" | "hold" | "block";

export interface Mandate {
  id: string;
  user_id: string;
  instruction_text: string;
  amount_cap: number | null;
  cumulative_cap: number | null;
  categories: string | null;      // comma separated, null = any
  expires_at: number;             // epoch ms
  status: "active" | "revoked" | "expired";
  created_at: number;
}

export interface PolicyResult {
  verdict: Verdict;
  rule: string | null;
  detail: string | null;
}

export interface IntentResult {
  aligned: boolean;
  confidence: number;
  reason: string;
  concerns: string[];
}

export interface InjectionResult {
  injection_detected: boolean;
  confidence: number;
  technique: string | null;
  span: string | null;
}

export interface Payment {
  tool: string;
  amount: number | null;
  currency: string | null;
  payee: string | null;
  description: string | null;
  raw: unknown;
}

export interface TransactionRow {
  id: string;
  session_id: string;
  mandate_id: string;
  tool_name: string;
  arguments_json: string;
  amount: number | null;
  currency: string | null;
  payee: string | null;
  verdict: Verdict;
  rule: string | null;
  policy_json: string;
  intent_json: string | null;
  injection_json: string | null;
  resolution: "auto" | "approved" | "denied" | "timeout" | null;
  created_at: number;
  resolved_at: number | null;
}
