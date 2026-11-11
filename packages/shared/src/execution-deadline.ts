/**
 * Absolute execution bounds can only shrink across workers and retries.
 * This validates deadlines and combines limits; it never grants permissions
 * or owns cancellation (the gateway and runners own live processes).
 */
export class ExecutionDeadlineError extends Error {
  constructor() {
    super('Execution deadline exceeded.');
    this.name = 'ExecutionDeadlineError';
  }
}

export function readExecutionDeadline(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid execution deadline');
  }
  return value as number;
}

export function normalizePositiveTimeoutMs(
  value: number | null | undefined,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return null;
  return Math.floor(value);
}

export function resolveExecutionDeadline(
  maxWallClockMs: number | null | undefined,
  deadlineAtMs: number | undefined,
  now = Date.now(),
): number | undefined {
  const absolute = readExecutionDeadline(deadlineAtMs);
  const duration = normalizePositiveTimeoutMs(maxWallClockMs);
  const relative =
    duration === null ? undefined : readExecutionDeadline(now + duration);
  return earliestExecutionDeadline(absolute, relative);
}

export function earliestExecutionDeadline(
  ...values: Array<number | undefined>
): number | undefined {
  let bound: number | undefined;
  for (const value of values) {
    const deadline = readExecutionDeadline(value);
    if (deadline !== undefined)
      bound = bound === undefined ? deadline : Math.min(bound, deadline);
  }
  return bound;
}

export function remainingExecutionMs(
  deadlineAtMs: number | undefined,
  now = Date.now(),
): number | undefined {
  const deadline = readExecutionDeadline(deadlineAtMs);
  return deadline === undefined ? undefined : Math.max(0, deadline - now);
}

export function throwIfExecutionDeadlineExceeded(
  deadlineAtMs: number | undefined,
): void {
  if (remainingExecutionMs(deadlineAtMs) === 0)
    throw new ExecutionDeadlineError();
}
