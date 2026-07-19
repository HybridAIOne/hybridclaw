import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REQUIRED_EVENT,
  adminEventsUrl,
  buildWebCommandRequestBody,
  clearStoredToken,
  dispatchAuthRequired,
  fetchAdminHybridAIBots,
  fetchAgentList,
  isLoopbackHostnameForTest,
  readStoredToken,
  registerDistillAgent,
  setAuthReloadHandlerForTest,
  setRuntimeSecret,
  storeToken,
  TOKEN_STORAGE_KEY,
  unblockSkill,
  updateAdminAgent,
  uploadDistillSource,
  uploadSkillZip,
} from './client';

function ensureLocalStorage() {
  if (typeof globalThis.localStorage?.clear === 'function') return;
  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } satisfies Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
  });
}

function ensureSessionStorage() {
  if (typeof globalThis.sessionStorage?.clear === 'function') return;
  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } satisfies Storage;
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, 'sessionStorage', {
    value: storage,
    configurable: true,
  });
}

describe('client command helpers', () => {
  beforeEach(() => {
    ensureLocalStorage();
    ensureSessionStorage();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the shared web command payload with optional user identity', () => {
    expect(
      buildWebCommandRequestBody({
        sessionId: 'session-a',
        args: ['stop'],
      }),
    ).toEqual({
      sessionId: 'session-a',
      guildId: null,
      channelId: 'web',
      args: ['stop'],
    });

    expect(
      buildWebCommandRequestBody({
        sessionId: 'session-a',
        args: ['echo', 'hello'],
        userId: 'web-user-1',
        username: 'web',
      }),
    ).toEqual({
      sessionId: 'session-a',
      guildId: null,
      channelId: 'web',
      args: ['echo', 'hello'],
      userId: 'web-user-1',
      username: 'web',
    });
  });

  it('clears legacy browser-stored tokens and URL auth params', () => {
    window.localStorage.clear();
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored-token');
    window.history.pushState(
      null,
      '',
      '/admin?token=query-token&__hybridclaw_token_bootstrapped=1&view=models#top',
    );

    expect(readStoredToken()).toBe('');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.location.pathname).toBe('/admin');
    expect(window.location.search).toBe('?view=models');
    expect(window.location.hash).toBe('#top');
  });

  it('removes query tokens from the URL without persisting them', () => {
    window.history.pushState(null, '', '/admin?token=query-token&view=models');

    expect(readStoredToken()).toBe('');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.location.search).toBe('?view=models');
  });

  it('clears legacy localStorage tokens without migrating them', () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'legacy-token');

    expect(readStoredToken()).toBe('');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('does not persist manual tokens in browser storage', () => {
    storeToken(' manual-token ');

    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();

    clearStoredToken();

    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('does not embed tokens into the admin events stream URL', () => {
    expect(adminEventsUrl('test-token')).toBe('/api/events');
  });

  it('maps local and remote agent list sources', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          agents: [{ id: 'main', name: 'Assistant' }],
          remotePeers: [
            {
              peerId: 'inst-peer',
              instanceId: 'inst-peer',
              agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
              agents: [{ id: 'remote@team@inst-peer', name: 'Remote' }],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(fetchAgentList('test-token')).resolves.toEqual([
      {
        id: 'main',
        name: 'Assistant',
        source: { type: 'local' },
      },
      {
        id: 'remote@team@inst-peer',
        name: 'Remote',
        source: {
          type: 'remote',
          peerId: 'inst-peer',
          instanceId: 'inst-peer',
        },
      },
    ]);
  });

  it('reloads local chat surfaces instead of prompting when auth expires', () => {
    const reload = vi.fn();
    const restoreReload = setAuthReloadHandlerForTest(reload);
    const events: CustomEvent[] = [];
    const listener = (event: Event) => {
      events.push(event as CustomEvent);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stale-token');
    window.history.pushState(null, '', '/chat/sess_20260514_135843_6136cbbb');

    dispatchAuthRequired('Unauthorized.');

    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);

    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
    restoreReload();
  });

  it('matches the server 127/8 loopback hostname range', () => {
    expect(isLoopbackHostnameForTest('127.0.0.1')).toBe(true);
    expect(isLoopbackHostnameForTest('127.12.34.56')).toBe(true);
    expect(isLoopbackHostnameForTest('localhost')).toBe(true);
    expect(isLoopbackHostnameForTest('example.com')).toBe(false);
  });

  it('prompts instead of repeatedly reloading local auth failures', () => {
    const reload = vi.fn();
    const restoreReload = setAuthReloadHandlerForTest(reload);
    const events: CustomEvent[] = [];
    const listener = (event: Event) => {
      events.push(event as CustomEvent);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);
    window.history.pushState(null, '', '/admin');
    window.sessionStorage.setItem(
      'hybridclaw_local_auth_reload_at',
      String(Date.now()),
    );

    dispatchAuthRequired('Unauthorized.');

    expect(reload).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      message: 'Unauthorized.',
    });

    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
    restoreReload();
  });

  it('posts admin commands through the shared web command payload', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    await setRuntimeSecret('test-token', 'OPENAI_API_KEY', 'test-secret');

    expect(fetch).toHaveBeenCalledWith(
      '/api/command',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      sessionId: 'web-admin-secrets',
      guildId: null,
      channelId: 'web',
      args: ['secret', 'set', 'OPENAI_API_KEY', 'test-secret'],
    });
  });

  it('uploads skill zips through requestJson rawBody and custom content-type', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const file = new File(['zip-bytes'], 'skill.zip', {
      type: 'application/zip',
    });

    await uploadSkillZip('test-token', file);

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/skills/upload',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/zip',
        }),
        body: file,
      }),
    );
  });

  it('uploads distill sources with subject query params and encoded filename', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ source: { path: '/tmp/memo.md' } }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const file = new File(['source text'], 'memo one.md', {
      type: 'text/markdown',
    });

    await uploadDistillSource('test-token', file, {
      alias: 'maya',
      agentId: 'research',
      kind: 'markdown',
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/distill/sources/upload?alias=maya&agentId=research&kind=markdown',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'text/markdown',
          'X-Hybridclaw-Filename': 'memo%20one.md',
        }),
        body: file,
      }),
    );
  });

  it('registers distill agents', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ subject: { alias: 'maya' } }), {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    await registerDistillAgent('test-token', {
      alias: 'maya',
      agentId: 'research',
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/distill/register',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ alias: 'maya', agentId: 'research' }),
      }),
    );
  });

  it('adds the force query parameter when uploading skill zips with force', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const file = new File(['zip-bytes'], 'skill.zip', {
      type: 'application/zip',
    });

    await uploadSkillZip('test-token', file, { force: true });

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/skills/upload?force=true',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/zip',
        }),
        body: file,
      }),
    );
  });

  it('posts skill unblock requests', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    await unblockSkill('test-token', 'rp26-schedule');

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/skills/unblock',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      name: 'rp26-schedule',
    });
  });

  it('updates admin agent proxy config through the agent endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          agent: {
            id: 'support',
            name: null,
            model: null,
            skills: null,
            chatbotId: null,
            enableRag: null,
            proxy: {
              kind: 'hybridai',
              baseUrl: 'https://hybridai.example.com',
              chatbotId: 'support-bot',
              apiKey: { source: 'store', id: 'HYBRIDAI_PROXY_KEY' },
              conversationScope: 'user',
            },
            role: null,
            reportsTo: null,
            delegatesTo: null,
            peers: null,
            workspace: null,
            workspacePath: '/tmp/support/workspace',
            markdownFiles: [],
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    const agent = await updateAdminAgent('test-token', 'support', {
      proxy: {
        kind: 'hybridai',
        baseUrl: 'https://hybridai.example.com',
        chatbotId: 'support-bot',
        apiKey: { source: 'store', id: 'HYBRIDAI_PROXY_KEY' },
        conversationScope: 'user',
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/agents/support',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      proxy: {
        kind: 'hybridai',
        baseUrl: 'https://hybridai.example.com',
        chatbotId: 'support-bot',
        apiKey: { source: 'store', id: 'HYBRIDAI_PROXY_KEY' },
        conversationScope: 'user',
      },
    });
    expect(agent.proxy?.apiKey.id).toBe('HYBRIDAI_PROXY_KEY');
  });

  it('persists an admin agent archive update', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          agent: {
            id: 'support',
            archived: true,
          },
        }),
        { status: 200 },
      ),
    );

    const agent = await updateAdminAgent('test-token', 'support', {
      archived: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/agents/support',
      expect.objectContaining({ method: 'PUT' }),
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({ archived: true });
    expect(agent.archived).toBe(true);
  });

  it('fetches HybridAI bot options from the admin endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          bots: [
            {
              id: 'bot-support',
              name: 'Support Bot',
              description: 'Handles support requests',
              model: 'gpt-5',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    const bots = await fetchAdminHybridAIBots(
      'test-token',
      'https://hybridai.one',
    );

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/hybridai/bots?baseUrl=https%3A%2F%2Fhybridai.one',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    expect(bots).toEqual([
      {
        id: 'bot-support',
        name: 'Support Bot',
        description: 'Handles support requests',
        model: 'gpt-5',
      },
    ]);
  });

  it('dispatches auth-required when skill zip upload returns 401', async () => {
    const events: CustomEvent[] = [];
    const listener = (event: Event) => {
      events.push(event as CustomEvent);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized.' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const file = new File(['zip-bytes'], 'skill.zip', {
      type: 'application/zip',
    });

    await expect(uploadSkillZip('test-token', file)).rejects.toThrow(
      'Unauthorized.',
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      message: 'Unauthorized.',
    });

    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
  });
});
