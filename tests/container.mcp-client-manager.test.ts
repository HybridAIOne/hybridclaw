import { describe, expect, test, vi } from 'vitest';

// The container package has its own SDK copy; errors must come from the same
// module instance that client-manager.ts checks with instanceof.
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '../container/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js';
import {
  ErrorCode,
  McpError,
} from '../container/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
import { McpClientManager } from '../container/src/mcp/client-manager.js';
import type {
  McpClientHandle,
  McpServerConfig,
} from '../container/src/mcp/types.js';

function makeConfig(command: string): McpServerConfig {
  return {
    transport: 'stdio',
    command,
    enabled: true,
  };
}

function makeHandle(serverName: string, toolName: string): McpClientHandle {
  return {
    serverName,
    config: makeConfig('node'),
    client: {} as never,
    transport: {} as never,
    tools: [
      {
        serverName,
        originalName: toolName,
        name: `${serverName}__${toolName}`,
        description: '',
        inputSchema: {},
        kind: 'other',
      },
    ],
    healthy: true,
  };
}

describe('McpClientManager tool namespacing', () => {
  test('keeps tool names unique when server names sanitize to the same segment', () => {
    const manager = new McpClientManager() as unknown as {
      configs: Map<string, McpServerConfig>;
      clients: Map<string, McpClientHandle>;
      toolIndex: Map<string, { serverName: string; toolName: string }>;
      rebuildToolIndex(): void;
      getAllToolDefinitions(): Array<{ function: { name: string } }>;
    };

    manager.configs.set('foo/bar', makeConfig('node'));
    manager.configs.set('foo bar', makeConfig('node'));
    manager.clients.set('foo/bar', makeHandle('foo/bar', 'list'));
    manager.clients.set('foo bar', makeHandle('foo bar', 'list'));

    manager.rebuildToolIndex();

    const names = manager
      .getAllToolDefinitions()
      .map((definition) => definition.function.name)
      .sort();

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(manager.toolIndex.size).toBe(2);
    expect(names.every((name) => name.startsWith('foo_bar_'))).toBe(true);
  });
});

describe('McpClientManager after a failed call', () => {
  test.each([
    ['an unannotated tool', undefined, 2],
    ['a read-only tool', { readOnlyHint: true }, 2],
    ['an idempotent write', { readOnlyHint: false, idempotentHint: true }, 2],
    ['a write', { readOnlyHint: false }, 1],
    ['an additive write', { destructiveHint: false }, 1],
  ] as const)('reconnects and sends %s %i time(s) in total', async (_label, annotations, calls) => {
    const callTool = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const rebuildClient = vi.fn(async () => {});
    const handle = makeHandle('mail', 'send');
    handle.client = { callTool } as never;
    handle.tools[0].annotations = annotations;
    const manager = new McpClientManager() as unknown as {
      configs: Map<string, McpServerConfig>;
      clients: Map<string, McpClientHandle>;
      rebuildToolIndex(): void;
      rebuildClient(name: string): Promise<void>;
      callToolDetailed(name: string, args: object): Promise<unknown>;
    };
    manager.configs.set('mail', makeConfig('node'));
    manager.clients.set('mail', handle);
    manager.rebuildToolIndex();
    manager.rebuildClient = rebuildClient;

    await expect(manager.callToolDetailed('mail__send', {})).rejects.toThrow(
      'socket hang up',
    );
    expect(callTool).toHaveBeenCalledTimes(calls);
    // Without the reconnect the server would keep no tools after one failure.
    expect(rebuildClient).toHaveBeenCalledOnce();
  });
});

type ManagerInternals = {
  configs: Map<string, McpServerConfig>;
  clients: Map<string, McpClientHandle>;
  rebuildToolIndex(): void;
  rebuildClient(name: string): Promise<void>;
  attachTransportHandlers(
    name: string,
    transport: { onerror?: (error: unknown) => void; onclose?: () => void },
  ): void;
  isKnownTool(name: string): boolean;
  callToolDetailed(name: string, args: object): Promise<unknown>;
};

function managerWith(handle: McpClientHandle): ManagerInternals {
  const manager = new McpClientManager() as unknown as ManagerInternals;
  manager.configs.set(handle.serverName, makeConfig('node'));
  manager.clients.set(handle.serverName, handle);
  manager.rebuildToolIndex();
  return manager;
}

describe('McpClientManager call timeout', () => {
  test('passes its tool-call timeout instead of the SDK default', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const handle = makeHandle('mail', 'send');
    handle.client = { callTool } as never;

    await managerWith(handle).callToolDetailed('mail__send', {});

    const options = callTool.mock.calls[0]?.[2] as { timeout?: number };
    expect(options?.timeout).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MSEC);
  });
});

describe('McpClientManager when the server answers with an error', () => {
  test.each([
    ErrorCode.InvalidParams,
    ErrorCode.InternalError,
    ErrorCode.MethodNotFound,
  ])('keeps the server and does not resend after JSON-RPC error %i', async (code) => {
    const callTool = vi
      .fn()
      .mockRejectedValue(new McpError(code, 'rejected by the server'));
    const handle = makeHandle('mail', 'send');
    handle.client = { callTool } as never;
    const manager = managerWith(handle);
    const rebuildClient = vi.fn(async () => {});
    manager.rebuildClient = rebuildClient;

    await expect(manager.callToolDetailed('mail__send', {})).rejects.toThrow(
      'rejected by the server',
    );
    expect(callTool).toHaveBeenCalledOnce();
    expect(rebuildClient).not.toHaveBeenCalled();
    expect(manager.isKnownTool('mail__send')).toBe(true);
  });

  test.each([
    ErrorCode.RequestTimeout,
    ErrorCode.ConnectionClosed,
  ])('still reconnects after connection-level error %i', async (code) => {
    const callTool = vi
      .fn()
      .mockRejectedValue(new McpError(code, 'connection lost'));
    const handle = makeHandle('mail', 'send');
    handle.client = { callTool } as never;
    const manager = managerWith(handle);
    const rebuildClient = vi.fn(async () => {});
    manager.rebuildClient = rebuildClient;

    await expect(manager.callToolDetailed('mail__send', {})).rejects.toThrow(
      'connection lost',
    );
    expect(rebuildClient).toHaveBeenCalledOnce();
  });
});

describe('McpClientManager transport events', () => {
  test('a recoverable transport error keeps the tools; a close drops them', () => {
    const manager = managerWith(makeHandle('mail', 'send'));
    const transport: {
      onerror?: (error: unknown) => void;
      onclose?: () => void;
    } = {};
    manager.attachTransportHandlers('mail', transport);

    transport.onerror?.(new Error('SSE stream disconnected'));
    expect(manager.isKnownTool('mail__send')).toBe(true);

    transport.onclose?.();
    expect(manager.isKnownTool('mail__send')).toBe(false);
  });
});
