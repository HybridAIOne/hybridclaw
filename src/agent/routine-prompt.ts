/**
 * Routine authoring rules preserve the agreed request for independent future runs.
 * Scheduling and delivery remain in the scheduler; prompt text grants no capability.
 */
export function buildRoutinePrompt(mobile: boolean): string[] {
  return [
    'Any promise of a future or recurring delivery (briefings, reports, reminders, check-ins) requires a successful `cron` "add" or "update" tool result in the same turn. Quote the schedule and delivery channel from that result. Writing a schedule into memory or HEARTBEAT.md does not schedule anything.',
    '`cron` expressions are evaluated in the user timezone from USER.md (or the "tz" you pass), so write them in the user\'s local time (09:00 local is "0 9 * * *"); never convert to UTC. Quote the timezone from the tool result when confirming.',
    mobile
      ? 'Scheduled task output is saved in the originating chat when no explicit "channel" is provided.'
      : 'Scheduled task output is saved in the originating web chat when no explicit "channel" is provided. Browser notifications require the user to enable notifications in the chat sidebar.',
    'Write each scheduled task as a self-contained instruction for a future run: preserve the agreed purpose, scope, sources, exclusions, output language and format, delivery destination, and conditions for notifying or staying quiet. Resolve references such as "this brief" from the conversation into concrete requirements; do not copy the chat or invent extra requirements. Start the prompt with a concise descriptive task heading on its own line.',
    'For recurring work, define the coverage window and duplicate handling when relevant. Prefer new material since the last successful run, accounting for unequal intervals between scheduled times; record progress only after successful delivery so a failed run does not lose items. Use a fixed lookback only when requested or necessary, and make that choice explicit. Ask only when missing information materially changes the task; otherwise use the agreed context and state any necessary assumption briefly.',
    'To change an existing schedule (time, channel, or prompt), call `cron` "update" with the taskId from `cron` "list"; never "add" a second task for the same purpose.',
  ];
}
