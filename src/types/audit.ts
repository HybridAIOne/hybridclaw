export interface AuditEntry {
  id: number;
  session_id: string | null;
  event: string;
  detail: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface StructuredAuditEntry {
  id: number;
  session_id: string;
  seq: number;
  event_type: string;
  timestamp: string;
  run_id: string;
  parent_run_id: string | null;
  payload: string;
  wire_hash: string;
  wire_prev_hash: string;
  created_at: string;
}

export interface ApprovalAuditEntry {
  id: number;
  session_id: string;
  tool_call_id: string;
  action: string;
  description: string | null;
  approved: number;
  approved_by: string | null;
  method: string;
  policy_name: string | null;
  timestamp: string;
}
