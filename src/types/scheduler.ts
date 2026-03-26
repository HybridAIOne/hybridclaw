export type ScheduleSideEffect =
  | {
      action: 'add';
      cronExpr?: string;
      runAt?: string;
      everyMs?: number;
      prompt: string;
    }
  | { action: 'remove'; taskId: number };

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
