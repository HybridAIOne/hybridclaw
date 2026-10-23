/**
 * One revision for every schedule editor. Run progress is deliberately excluded;
 * configuration changes invalidate a stale editor without making a run a conflict.
 */
import { createHash } from 'node:crypto';
import type { ScheduledTask } from '../types/scheduler.js';
export function taskRevision(task: ScheduledTask): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        task.prompt,
        task.cron_expr,
        task.tz,
        task.run_at,
        task.every_ms,
        task.enabled,
        task.title ?? null,
        task.model ?? null,
        task.effort ?? null,
        task.fresh_session ?? false,
        task.session_id,
        task.channel_id,
        task.reply_only ?? false,
        task.alert ?? null,
        task.trigger ?? null,
      ]),
    )
    .digest('hex');
}
