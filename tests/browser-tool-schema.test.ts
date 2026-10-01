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
});

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
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        success: true,
        url: 'https://example.com/',
        title: '',
        content_text_length: 0,
        content_preview_truncated: false,
        ready_state: 'native',
        read_extraction_hint: 'native_browser',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
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
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    toolName: 'browser_navigate',
    sessionId: 'sess-mac',
    agentId: 'agent-main',
    args: { url: 'https://example.com' },
  });
  expect(result).toMatchObject({
    success: true,
    provider: 'mac-cua',
    audit_session_id: 'sess-mac',
    url: 'https://example.com/',
    ready_state: 'native',
  });
});

test.each([
  { provider: 'mac-cua', headed: true },
  { provider: 'managed-cloud', headed: false },
])('gateway browser_navigate reports headed=$headed for $provider', async ({
  provider,
  headed,
}) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true }), {
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
