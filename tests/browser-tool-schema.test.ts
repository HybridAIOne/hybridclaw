import { afterEach, expect, test, vi } from 'vitest';

import {
  BROWSER_TOOL_DEFINITIONS,
  executeBrowserTool,
  getBrowserProviderLogLabel,
  setBrowserGatewayContext,
  usesGatewayManagedBrowser,
} from '../container/src/browser-tools.js';

afterEach(() => {
  setBrowserGatewayContext('', '', '', '', '');
  vi.unstubAllGlobals();
});

// Model-facing browser calls; mac-cua also asks for a live-view frame after
// each page-changing one.
function gatewayToolCalls(
  fetchMock: ReturnType<typeof vi.fn>,
): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .map(
      ([, init]) =>
        JSON.parse(String((init as RequestInit | undefined)?.body || '{}')) as Record<
          string,
          unknown
        >,
    )
    .filter((body) => body.toolName !== 'browser_frame');
}

function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('browser_click schema avoids unsupported top-level combinators', () => {
  const browserClick = BROWSER_TOOL_DEFINITIONS.find(
    (entry) =>
      entry.type === 'function' && entry.function.name === 'browser_click',
  );
  expect(browserClick).toBeDefined();

  const parameters = browserClick?.function.parameters as {
    anyOf?: unknown;
    oneOf?: unknown;
    allOf?: unknown;
    not?: unknown;
    required?: string[];
  };

  expect(parameters.required).toEqual([]);
  expect(parameters.anyOf).toBeUndefined();
  expect(parameters.oneOf).toBeUndefined();
  expect(parameters.allOf).toBeUndefined();
  expect(parameters.not).toBeUndefined();
});

test('browser_resume_interaction allows native sessions without DOM refs', () => {
  const browserResume = BROWSER_TOOL_DEFINITIONS.find(
    (entry) =>
      entry.type === 'function' &&
      entry.function.name === 'browser_resume_interaction',
  );
  expect(browserResume).toBeDefined();

  const parameters = browserResume?.function.parameters as {
    required?: string[];
  };

  expect(parameters.required).toEqual([]);
});

test('browser provider log label follows gateway context and defaults to local', () => {
  setBrowserGatewayContext('', '', '', '', '');
  expect(getBrowserProviderLogLabel()).toBe('local');
  expect(usesGatewayManagedBrowser()).toBe(false);

  setBrowserGatewayContext('', '', 'managed-cloud', 'session-1', 'main');
  expect(getBrowserProviderLogLabel()).toBe('managed-cloud');
  expect(usesGatewayManagedBrowser()).toBe(true);

  setBrowserGatewayContext('', '', 'mac-cua', 'session-1', 'main');
  expect(getBrowserProviderLogLabel()).toBe('mac-cua');
  expect(usesGatewayManagedBrowser()).toBe(true);

  setBrowserGatewayContext('', '', 'local', 'session-1', 'main');
  expect(usesGatewayManagedBrowser()).toBe(false);
});

// Plugin providers run in the gateway; the sandbox cannot run their code, so
// it must never drive its own local browser for them.
test.each(['camofox', 'browser-use-cloud', 'browserbase'])(
  'a %s browser provider routes browser tools through the gateway',
  (provider) => {
    setBrowserGatewayContext('', '', provider, 'session-1', 'main');
    expect(usesGatewayManagedBrowser()).toBe(true);
  },
);

test('managed browser resume reuses the parked suspended session id', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const { toolName } = JSON.parse(String(init?.body || '{}'));
    if (toolName === 'browser_navigate') {
      return jsonResponse({
        success: true,
        url: 'http://127.0.0.1:18924/index.html',
        parked: true,
        interaction: {
          session: {
            sessionId: 'suspended-2fa',
          },
        },
      });
    }
    if (toolName === 'browser_resume_interaction') {
      return jsonResponse({
        success: true,
        resumed: true,
        response_kind: 'code',
        code_injected: true,
        selector: '@e24',
      });
    }
    return jsonResponse({ success: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  setBrowserGatewayContext(
    'http://127.0.0.1:4317',
    'test-token',
    'mac-cua',
    'sess-mac',
    'agent-main',
  );

  await executeBrowserTool(
    'browser_navigate',
    { url: 'http://127.0.0.1:18924/index.html' },
    'container-session',
  );
  const result = JSON.parse(
    await executeBrowserTool(
      'browser_resume_interaction',
      {},
      'container-session',
    ),
  ) as Record<string, unknown>;

  const calls = gatewayToolCalls(fetchMock);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({
    toolName: 'browser_resume_interaction',
    sessionId: 'sess-mac',
    agentId: 'agent-main',
    args: { sessionId: 'suspended-2fa' },
  });
  expect(result).toMatchObject({
    success: true,
    provider: 'mac-cua',
    resumed: true,
    code_injected: true,
  });
});

test('mac-cua browser tools route through the gateway provider', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const { toolName } = JSON.parse(String(init?.body || '{}'));
    return jsonResponse(
      toolName === 'browser_snapshot'
        ? {
            success: true,
            url: 'https://example.com/',
            title: 'Example Domain',
            snapshot: '- link "Learn more" [ref=e1]',
            element_count: 1,
          }
        : { success: true, url: 'https://example.com/', title: '' },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  setBrowserGatewayContext(
    'http://127.0.0.1:4317',
    'test-token',
    'mac-cua',
    'sess-mac',
    'agent-main',
  );

  const result = JSON.parse(
    await executeBrowserTool(
      'browser_navigate',
      { url: 'https://example.com' },
      'container-session',
    ),
  ) as Record<string, unknown>;

  const calls = gatewayToolCalls(fetchMock);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    toolName: 'browser_navigate',
    sessionId: 'sess-mac',
    agentId: 'agent-main',
    args: { url: 'https://example.com' },
  });
  // Navigate returns the page, so the model needs no browser_snapshot call.
  expect(calls[1]).toMatchObject({
    toolName: 'browser_snapshot',
    sessionId: 'sess-mac',
    args: { mode: 'full' },
  });
  expect(result).toMatchObject({
    success: true,
    provider: 'mac-cua',
    audit_session_id: 'sess-mac',
    url: 'https://example.com/',
    title: 'Example Domain',
    snapshot: '- link "Learn more" [ref=e1]',
    element_count: 1,
  });
});

test.each([
  { provider: 'mac-cua', gatewayHeaded: true, headed: true },
  { provider: 'managed-cloud', gatewayHeaded: undefined, headed: false },
])('gateway browser_navigate reports headed=$headed for $provider', async ({
  provider,
  gatewayHeaded,
  headed,
}) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, headed: gatewayHeaded }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
  setBrowserGatewayContext(
    'http://127.0.0.1:4317',
    'test-token',
    provider,
    'sess-gateway',
    'agent-main',
  );

  const result = JSON.parse(
    await executeBrowserTool(
      'browser_navigate',
      { url: 'https://example.com', headed: true },
      'container-session',
    ),
  ) as Record<string, unknown>;

  expect(result).toMatchObject({ success: true, provider, headed });
});
