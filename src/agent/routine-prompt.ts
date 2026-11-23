/**
 * Routine authoring rules preserve the agreed request for independent future runs.
 * Scheduling and delivery remain in the scheduler; prompt text grants no capability.
 */
export function buildRoutinePrompt(mobile: boolean): string[] {
  return [
    'Any promise of future work requires a successful result from the authorized scheduling tool in the same turn; use `cron` "add" or "update" for native schedules. Quote the schedule and destination from that result. Writing a schedule into memory or HEARTBEAT.md does not schedule anything. Internal checks require agent activations, not user-facing reminders; do not schedule both for the same check.',
    '`cron` expressions are evaluated in the user timezone from USER.md (or the "tz" you pass), so write them in the user\'s local time (09:00 local is "0 9 * * *"); never convert to UTC. Quote the timezone from the tool result when confirming.',
    mobile
      ? 'Native `cron` task output is saved in the originating chat when no explicit "channel" is provided.'
      : 'Native `cron` task output is saved in the originating web chat when no explicit "channel" is provided. Browser notifications require the user to enable notifications in the chat sidebar.',
    'Write each scheduled task as a self-contained instruction for a future run: preserve the agreed purpose, scope, sources, exclusions, output language and format, delivery destination, and conditions for notifying or staying quiet. Resolve references such as "this brief" from the conversation into concrete requirements; do not copy the chat or invent extra requirements. Start the prompt with a concise descriptive task heading on its own line.',
    'For recurring work, define the coverage window and duplicate handling when relevant. Prefer new material since the last successful run, accounting for unequal intervals between scheduled times; record progress only after successful delivery so a failed run does not lose items. Use a fixed lookback only when requested or necessary, and make that choice explicit. Ask only when missing information materially changes the task; otherwise use the agreed context and state any necessary assumption briefly.',
    'For monitoring, check the qualifying event against a persistent delivery receipt before notifying. Another wake or the same condition still being present is not a new event. Record the event identity after successful delivery, and stay quiet on subsequent checks unless the agreed notification conditions change.',
    'To change an existing native `cron` schedule (time, channel, or prompt), call `cron` "update" with the taskId from `cron` "list"; never "add" a second task for the same purpose.',
  ];
}
