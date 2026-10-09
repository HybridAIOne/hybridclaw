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
  /** Original proactive policy or trigger; queued changes are cancelled if it changes. */
  event_parent_id?: number | null;
  /** Runs when something arrives instead of (or besides) a time (`event-triggers.ts`). */
  trigger?: TaskTrigger | null;
  /** What arrived, on a trigger's queued run. */
  trigger_event?: TriggerEvent | null;
}

export type TriggerSource = 'mail' | 'slack' | 'webhook';

export interface TaskTrigger {
  source: TriggerSource;
  /** Webhook only: the secret part of its web address. */
  token?: string;
  /** Slack only: the channel name or id it watches; none watches every channel. */
  channel?: string;
  /** Slack only: text a message must contain. */
  contains?: string;
}

/**
 * Mail and relayed Slack changes carry nothing: the run reads the source with
 * its tools. A Slack channel message and a webhook call carry what arrived.
 */
export interface TriggerEvent {
  at: string;
  slack?: { channel: string; user: string; text: string };
  body?: string;
}
