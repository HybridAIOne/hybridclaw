/** Records IDs from non-streaming helper calls; streamed calls use native logs.
 * Requests and response contents are unchanged, and credentials are never saved.
 */
import fs from 'node:fs';
import path from 'node:path';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    url.origin === 'https://openrouter.ai' &&
    url.pathname === '/api/v1/chat/completions' &&
    response.headers.get('content-type')?.includes('application/json')
  ) {
    try {
      const payload = await response.clone().json();
      const root = process.env.HYBRIDCLAW_DATA_DIR;
      if (
        root &&
        typeof payload.id === 'string' &&
        payload.id.startsWith('gen-')
      ) {
        const file = path.join(root, 'data/gateway/generation-ids.log');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(
          file,
          '[model-response-debug] ' +
            JSON.stringify({
              id: payload.id,
              model: payload.model,
            }) +
            '\n',
          { mode: 0o600 },
        );
      }
    } catch {
      // Observation must not change whether the original response succeeds.
    }
  }
  return response;
};
