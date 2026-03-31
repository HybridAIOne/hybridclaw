export interface ScheduledTask {
  id: number;
  session_id: string;
  channel_id: string;
  cron_expr: string;
  run_at: string | null;
  every_ms: number | null;
  prompt: string;
  enabled: number;
  last_run: string | null;
  last_status: string | null;
  consecutive_errors: number;
  created_at: string;
}

// CamelCase projection of ScheduledTask passed over the container IPC boundary.
export interface ScheduledTaskInput {
  id: number;
  cronExpr: string;
  runAt: string | null;
  everyMs: number | null;
  prompt: string;
  enabled: number;
  lastRun: string | null;
  createdAt: string;
}
