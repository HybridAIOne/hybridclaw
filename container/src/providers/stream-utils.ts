/**
 * Maximum silence on a streaming request, both while waiting for the response
 * headers and between body chunks, before treating the connection as stale.
 * When this fires the request is aborted and the resulting error is retryable
 * via `model-retry.ts`.
 *
 * 90 seconds is generous — models can pause for 30-60 s during complex tool
 * call generation, but anything beyond 90 s with zero bytes typically means
 * the upstream connection is dying.
 */
export const STREAM_IDLE_TIMEOUT_MS = 90_000;

/**
 * Start a streaming request whose response headers must arrive within
 * STREAM_IDLE_TIMEOUT_MS instead of undici's 300 s. The HybridAI relay holds
 * its headers until the first model token when it can fall back to another
 * model, so this wait is the same silence the body reads are bounded by, and
 * it gets the same bound and recovery (agent call, 2026-10-02, pending owner
 * review; a separate, shorter first-byte budget was deferred).
 */
export async function fetchWithHeaderTimeout(
  send: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(
        `Stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms waiting for response headers`,
      ),
    );
  }, STREAM_IDLE_TIMEOUT_MS);
  try {
    return await send(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

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
