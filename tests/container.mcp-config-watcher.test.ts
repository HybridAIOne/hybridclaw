import { describe, expect, test, vi } from 'vitest';

import { McpConfigWatcher } from '../container/src/mcp/config-watcher.js';
import type { McpClientManager } from '../container/src/mcp/client-manager.js';
import type { McpServerConfig } from '../container/src/mcp/types.js';

function httpServer(url: string): McpServerConfig {
  return { transport: 'http', url };
}

/**
 * The watcher must isolate per-server failures. A single MCP server whose
 * connection rejects (e.g. an expired OAuth token answering with
 * 401/invalid_token) previously rejected applyConfig, which propagated up
 * through syncMcpConfig into the chat turn and crashed it — taking down ALL
 * chat for the agent.
 */
describe('McpConfigWatcher.applyConfig graceful failure', () => {
  test('a failing replaceClient does not reject applyConfig', async () => {
    const replaceClient = vi.fn(async (name: string) => {
      if (name === 'broken') {
        throw new Error(
          'Streamable HTTP error: invalid_token / Missing or invalid access token',
        );
      }
    });
    const manager = {
      replaceClient,
      removeClient: vi.fn(async () => undefined),
    } as unknown as McpClientManager;

    const watcher = new McpConfigWatcher(manager);

    await expect(
      watcher.applyConfig({
        broken: httpServer('https://example.com/broken'),
        healthy: httpServer('https://example.com/healthy'),
      }),
    ).resolves.toBe(true);

    // Both servers were attempted; the broken one did not short-circuit the rest.
    expect(replaceClient).toHaveBeenCalledTimes(2);
    expect(replaceClient.mock.calls.map((c) => c[0]).sort()).toEqual([
      'broken',
      'healthy',
    ]);
  });

  test('a failing removeClient does not reject applyConfig', async () => {
    const manager = {
      replaceClient: vi.fn(async () => undefined),
      removeClient: vi.fn(async () => {
        throw new Error('shutdown failed');
      }),
    } as unknown as McpClientManager;

    const watcher = new McpConfigWatcher(manager);
    // Seed lastConfig so the next apply triggers a removal.
    await watcher.applyConfig({ gone: httpServer('https://example.com/gone') });

    await expect(watcher.applyConfig({})).resolves.toBe(true);
    expect(manager.removeClient).toHaveBeenCalledWith('gone');
  });

  test('healthy servers still connect when another server fails', async () => {
    const connected: string[] = [];
    const manager = {
      replaceClient: vi.fn(async (name: string) => {
        if (name === 'broken') throw new Error('401 invalid_token');
        connected.push(name);
      }),
      removeClient: vi.fn(async () => undefined),
    } as unknown as McpClientManager;

    const watcher = new McpConfigWatcher(manager);
    await watcher.applyConfig({
      broken: httpServer('https://example.com/broken'),
      a: httpServer('https://example.com/a'),
      b: httpServer('https://example.com/b'),
    });

    expect(connected.sort()).toEqual(['a', 'b']);
  });
});

function fakeManager() {
  return {
    replaceClient: vi.fn(async () => undefined),
    rotateAuthorization: vi.fn(async () => undefined),
    removeClient: vi.fn(async () => undefined),
  };
}

describe('McpConfigWatcher connects', () => {
  test('servers in parallel', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = fakeManager();
    manager.replaceClient.mockImplementation(() => gate);
    const watcher = new McpConfigWatcher(
      manager as unknown as McpClientManager,
    );

    const applied = watcher.applyConfig({
      a: httpServer('https://example.com/a'),
      b: httpServer('https://example.com/b'),
    });
    await vi.waitFor(() => expect(manager.replaceClient).toHaveBeenCalledTimes(2));
    release();
    await expect(applied).resolves.toBe(true);
  });

  test('an apply started during another waits for it instead of reconnecting', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = fakeManager();
    manager.replaceClient.mockImplementation(() => gate);
    const watcher = new McpConfigWatcher(
      manager as unknown as McpClientManager,
    );
    const servers = { a: httpServer('https://example.com/a') };

    const warm = watcher.applyConfig(servers);
    const firstRequest = watcher.applyConfig(servers);
    release();

    await expect(warm).resolves.toBe(true);
    await expect(firstRequest).resolves.toBe(false);
    expect(manager.replaceClient).toHaveBeenCalledTimes(1);
  });
});

describe('McpConfigWatcher after a config change', () => {
  const before: McpServerConfig = {
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer one' },
  };

  test.each([
    [
      'rotates a changed token in place',
      { ...before, headers: { Authorization: 'Bearer two' } },
      'rotateAuthorization',
    ],
    [
      'reconnects when another header changes too',
      { ...before, headers: { Authorization: 'Bearer two', 'X-Tenant': 'b' } },
      'replaceClient',
    ],
    [
      'reconnects when the URL changes',
      { ...before, url: 'https://example.com/other' },
      'replaceClient',
    ],
    [
      'reconnects when the token is removed',
      { ...before, headers: {} },
      'replaceClient',
    ],
  ] as const)('%s', async (_label, after, method) => {
    const manager = fakeManager();
    const watcher = new McpConfigWatcher(
      manager as unknown as McpClientManager,
    );
    await watcher.applyConfig({ docs: before });
    manager.replaceClient.mockClear();

    await watcher.applyConfig({ docs: after });

    expect(manager[method]).toHaveBeenCalledWith('docs', after);
    const other =
      method === 'replaceClient'
        ? manager.rotateAuthorization
        : manager.replaceClient;
    expect(other).not.toHaveBeenCalled();
  });
});
