import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REQUIRED_EVENT,
  buildWebCommandRequestBody,
  dispatchAuthRequired,
  isLoopbackHostnameForTest,
  readStoredToken,
  registerDistillAgent,
  setAuthReloadHandlerForTest,
  setRuntimeSecret,
  TOKEN_STORAGE_KEY,
  unblockSkill,
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

  it('removes the local token bootstrap marker after reading stored auth', () => {
    window.localStorage.clear();
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'stored-token');
    window.history.pushState(
      null,
      '',
      '/admin?__hybridclaw_token_bootstrapped=1&view=models#top',
    );

    expect(readStoredToken()).toBe('stored-token');
    expect(window.location.pathname).toBe('/admin');
    expect(window.location.search).toBe('?view=models');
    expect(window.location.hash).toBe('#top');
  });

  it('reloads local chat surfaces instead of prompting when auth expires', () => {
    const reload = vi.fn();
    const restoreReload = setAuthReloadHandlerForTest(reload);
    const events: CustomEvent[] = [];
    const listener = (event: Event) => {
      events.push(event as CustomEvent);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'stale-token');
    window.history.pushState(null, '', '/chat/sess_20260514_135843_6136cbbb');

    dispatchAuthRequired('Unauthorized.');

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
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
