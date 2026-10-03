import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllEnvs: true, resetModules: true });

const url = 'https://93.184.216.34/app';
const shell = '<html><head><title>Example App</title><script src="https://www.google.com/recaptcha/enterprise.js"></script></head><body><div id="app"></div></body></html>';
const htmlResponse = (html: string) => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });

test.each([false, true])('fetch continuation uses the requested URL (redirect: %s)', async (redirect) => {
  const fetchMock = vi.fn(async (request: string | URL | Request) => redirect && String(request) === url
    ? new Response(null, { status: 302, headers: { Location: 'https://1.1.1.1/app' } })
    : htmlResponse(shell));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { executeTool } = await import('../container/src/tools.js');
    const output = await executeTool('web_fetch', JSON.stringify({ url }));
    const continuation = /Next retrieval: (\{[^\n]+\})\./.exec(output);
    expect(continuation).not.toBeNull();
    expect(JSON.parse(continuation![1])).toEqual({ name: 'browser_navigate', arguments: { url } });
    expect(output).toContain('spa_shell_only');
    expect(output).not.toContain('bot_blocked');
    expect(fetchMock).toHaveBeenCalledTimes(redirect ? 2 : 1);
    if (redirect) expect(output).toContain('https://1.1.1.1/app');
  } finally { vi.unstubAllGlobals(); }
});

test('a real access challenge does not prescribe another retrieval', async () => {
  const fetchMock = vi.fn(async () => htmlResponse('<html><body><h1>Verification required</h1><p>Complete the CAPTCHA to continue.</p></body></html>'));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { executeTool } = await import('../container/src/tools.js');
    const output = await executeTool('web_fetch', JSON.stringify({ url }));
    expect(output).toContain('bot_blocked');
    expect(output).not.toContain('Next retrieval:');
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
