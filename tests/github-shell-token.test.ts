import type { ServerResponse } from 'node:http';
import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const getScope = vi.hoisted(() => vi.fn());
vi.mock('../src/auth/hybridai-auth.js', () => ({
  readHybridAIApiKey: () => 'test-key',
}));
vi.mock('../src/auth/google-auth.js', () => ({
  resolveGoogleWorkspaceRuntimeEnv: async () => ({ GOG_ACCOUNT: 'user_a' }),
  getGoogleWorkspaceRuntimeEnvRecoveryHint: () => '',
}));
vi.mock('../src/scopes/scope-store.js', () => ({ getScope }));
vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn() } }));

useCleanMocks({ unstubAllGlobals: true, resetModules: true });

async function shellEnv(
  scope?: { agentId: string; scopeId: string },
): Promise<Record<string, string>> {
  const { handleApiShellEnv } = await import(
    '../src/gateway/gateway-shell-env.js'
  );
  const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
  await handleApiShellEnv(res as unknown as ServerResponse, true, scope);
  expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  return JSON.parse(String(res.end.mock.calls[0][0]));
}

test.each([
  { scope: undefined, connectors: [], token: true },
  { scope: { agentId: 'main', scopeId: 'work' }, connectors: ['github'], token: true },
  { scope: { agentId: 'main', scopeId: 'work' }, connectors: ['google'], token: false },
  { scope: { agentId: 'main', scopeId: 'gone' }, connectors: null, token: false },
])(
  'shell env carries the connected GitHub token only where the scope allows it ($connectors)',
  async ({ scope, connectors, token }) => {
    getScope.mockReturnValue(connectors && { connectors });
    const fetchMock = vi.fn(async () =>
      Response.json({ username: 'x-access-token', password: 'gh-test-token' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = await shellEnv(scope);
    expect(env).toEqual(
      token
        ? { GOG_ACCOUNT: 'user_a', GH_TOKEN: 'gh-test-token' }
        : { GOG_ACCOUNT: 'user_a' },
    );
    if (token)
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/v1\/connectors\/github\/git-credential$/),
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer test-key' },
        }),
      );
    else expect(fetchMock).not.toHaveBeenCalled();
  },
);

test.each([
  ['unreachable', () => Promise.reject(new Error('connect ECONNREFUSED'))],
  ['not connected', async () => Response.json({ error: 'not_connected' }, { status: 404 })],
])(
  'a platform that is %s leaves shell env intact and is not asked again on every command',
  async (_label, reply) => {
    const fetchMock = vi.fn(reply);
    vi.stubGlobal('fetch', fetchMock);
    expect(await shellEnv()).toEqual({ GOG_ACCOUNT: 'user_a' });
    expect(await shellEnv()).toEqual({ GOG_ACCOUNT: 'user_a' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);
