export const TOOL_ACTIVITY_HEARTBEAT_MS = 10_000;
export const STREAM_ACTIVITY_LINE = '[stream-activity]';

export function emitStreamActivityLine(): void {
  console.error(STREAM_ACTIVITY_LINE);
}

/**
 * Run a tool while periodically emitting an activity signal so the gateway's
 * inactivity watchdog keeps extending its idle deadline. Tools that stay
 * silent for longer than the idle window (long shell commands, MCP calls,
 * browser or video work) would otherwise be killed mid-execution.
 */
export async function withToolActivityHeartbeat<T>(
  run: () => Promise<T>,
  emitActivity: () => void,
  intervalMs = TOOL_ACTIVITY_HEARTBEAT_MS,
): Promise<T> {
  const timer = setInterval(emitActivity, intervalMs);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}
