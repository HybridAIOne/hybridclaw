/**
 * Maximum time to wait for the next chunk from a streaming response before
 * treating the connection as stale. When this fires the reader is cancelled
 * and the resulting error is retryable via `model-retry.ts`.
 *
 * 90 seconds is generous — models can pause for 30-60 s during complex tool
 * call generation, but anything beyond 90 s with zero bytes typically means
 * the upstream connection is dying.
 */
export const STREAM_IDLE_TIMEOUT_MS = 90_000;

/**
 * Wrap `reader.read()` with an idle-timeout so a silently-stalled connection
 * surfaces a retryable error instead of hanging until the TCP stack gives up
 * (which can take minutes and produces the opaque "terminated" TypeError).
 */
export function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error(`Stream idle timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
