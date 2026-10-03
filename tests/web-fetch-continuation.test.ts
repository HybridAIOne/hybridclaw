import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllEnvs: true });

test('fetch escalation supplies the final source URL without invoking a browser', async () => {
  const fetchMock = vi.fn(async () => new Response('<html><head><title>Example App</title></head><body><div id="app"></div></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { executeTool } = await import('../container/src/tools.js');
    const output = await executeTool('web_fetch', JSON.stringify({ url: 'https://93.184.216.34/app' }));
    const continuation = /Next retrieval: (\{[^\n]+\})\./.exec(output);
    expect(continuation).not.toBeNull();
    expect(JSON.parse(continuation![1])).toEqual({ name: 'browser_navigate', arguments: { url: 'https://93.184.216.34/app' } });
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
