/**
 * Shutdown latch of the agent process: once shutdown starts, nothing new
 * starts. `waitForInput` consumes no more input, since a replacement agent can
 * share the session's IPC directory; model calls, tool approvals and runs, and
 * replies park in `haltIfShuttingDown` until the process exits. NOT the
 * teardown (index.ts) and NOT the interrupted reply (`shutdown-output.ts`).
 */
let shutdown: Promise<never> | null = null;

/** Runs `teardown` on the first call; every call returns its promise. */
export function startShutdown(teardown: () => Promise<never>): Promise<never> {
  shutdown ??= teardown();
  return shutdown;
}

export function isShuttingDown(): boolean {
  return shutdown !== null;
}

/**
 * Returns at once before shutdown; after it, never returns, even if teardown
 * fails, so parked work cannot resume.
 */
export async function haltIfShuttingDown(): Promise<void> {
  if (shutdown) await new Promise<never>(() => {});
}
