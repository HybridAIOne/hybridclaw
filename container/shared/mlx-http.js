/**
 * Native MLX HTTP requests expire on inactivity, not total generation time.
 * Unlike the IPC transport, this owns only fetch cancellation and stream cleanup;
 * callers still pin loopback destinations, credentials, and model selection.
 */
// 2026-09-10, owner long-reasoning request: retain the former three-minute wait
// as an idle bound. Tune prefill tolerance only with separate Mac measurements.
export const MLX_IDLE_TIMEOUT_MS = 180_000;
// 2026-09-10, Codex: allow 40,960 single-token SSE frames (~1 KiB each)
// with framing headroom, while retaining finite wire and base64 IPC storage bounds.
export const MLX_MAX_RESPONSE_BYTES = 64 * 1024 ** 2;
export const MLX_MAX_RELAY_BYTES = 96 * 1024 ** 2;

export async function fetchMlxWithIdleTimeout(url, init) {
  const abort = new AbortController();
  const signal = AbortSignal.any([
    abort.signal,
    ...(init.signal ? [init.signal] : []),
  ]);
  const expire = () =>
    abort.abort(new Error('Local inference stopped making progress.'));
  let timer = setTimeout(expire, MLX_IDLE_TIMEOUT_MS);
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(expire, MLX_IDLE_TIMEOUT_MS);
  };
  try {
    const response = await fetch(url, { ...init, signal });
    if (!response.body) {
      clearTimeout(timer);
      return response;
    }
    refresh();
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearTimeout(timer);
              controller.close();
            } else {
              refresh();
              controller.enqueue(value);
            }
          } catch (error) {
            clearTimeout(timer);
            abort.abort();
            controller.error(error);
          }
        },
        cancel(reason) {
          clearTimeout(timer);
          const cancelled = reader.cancel(reason);
          abort.abort();
          return cancelled.catch(() => {});
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  } catch (error) {
    clearTimeout(timer);
    abort.abort();
    throw error;
  }
}
