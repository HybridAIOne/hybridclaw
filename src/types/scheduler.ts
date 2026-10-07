export interface ScheduledTask {
  title?: string | null;
  model?: string | null;
  effort?:
    | import('../../container/shared/reasoning-effort.js').ReasoningEffort
    | null;
  fresh_session?: boolean;
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
  /** Phone alert kind for a run whose reply is a list of items (`/schedule add --alert`). */
  alert?: string | null;
  /**
   * Runs keep their prompt and work out of the chat; only a reply that says
   * something is posted to it (`/schedule add --reply-only`).
   */
  reply_only?: boolean;
  /** Verified creator, retained across edits; never selected by model tool arguments. */
  owner_user_id?: string | null;
  /** Original proactive policy; queued changes are cancelled if it changes. */
  event_parent_id?: number | null;
}
