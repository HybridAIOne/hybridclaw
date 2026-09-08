export interface ScheduledTask {
  id: number;
  session_id: string;
  channel_id: string;
  cron_expr: string;
  tz: string;
  run_at: string | null;
  every_ms: number | null;
  prompt: string;
  enabled: number;
  last_run: string | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_errors: number;
  created_at: string;
}

export interface ScheduledTaskInput {
  id: number;
  channelId: string;
  cronExpr: string;
  tz: string;
  runAt: string | null;
  everyMs: number | null;
  prompt: string;
  enabled: number;
  lastRun: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  createdAt: string;
}
