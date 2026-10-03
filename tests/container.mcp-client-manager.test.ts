import { describe, expect, test, vi } from 'vitest';

// The container package has its own SDK copy; errors must come from the same
// module instance that client-manager.ts checks with instanceof.
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '../container/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js';
import {
  ErrorCode,
  McpError,
} from '../container/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
import { McpClientManager } from '../container/src/mcp/client-manager.js';
import {
  DEFER_LOADING_META,
  type McpClientHandle,
  type McpServerConfig,
} from '../container/src/mcp/types.js';
import { ToolCatalog } from '../container/src/tool-catalog.js';
import { leadingParallelRun } from '../container/src/tool-parallelism.js';
import type { ToolDefinition } from '../container/src/types.js';

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
  test('rejects malformed IPC declarations before connecting or changing config', async () => {
    const manager = new McpClientManager();
    const internals = manager as unknown as ManagerInternals;
    await expect(
      manager.replaceClient('mail', {
        ...makeConfig('node'),
        toolBehavior: { trustAnnotations: 'true' } as never,
      }),
    ).rejects.toThrow();
    expect(internals.configs.size).toBe(0);
    expect(internals.clients.size).toBe(0);
  });

  test('binds concurrency trust to the live handle and revokes it with discovery', () => {
    const manager = new McpClientManager();
    const internals = manager as unknown as ManagerInternals;
    const handle = makeHandle('mail', 'lookup');
    handle.tools[0].annotations = { readOnlyHint: true };
    internals.configs.set('mail', {
      ...makeConfig('node'),
      toolBehavior: { trustAnnotations: true },
    });
    internals.clients.set('mail', handle);
    internals.rebuildToolIndex();
    // A pending or failed replacement's config must not bless the old handle.
    expect(manager.getToolBehavior('mail__lookup')?.parallelSafe).toBe(false);
    handle.config.toolBehavior = { trustAnnotations: true };
    expect(manager.getToolBehavior('mail__lookup')?.parallelSafe).toBe(true);
    internals.configs.set('mail', makeConfig('node'));
    expect(manager.getToolBehavior('mail__lookup')?.parallelSafe).toBe(false);
    internals.configs.set('mail', {
      ...makeConfig('node'),
      toolBehavior: { trustAnnotations: true },
    });
    const calls = ['a', 'b'].map((id) => ({
      id,
      type: 'function' as const,
      function: { name: 'mail__lookup', arguments: '{}' },
    }));
    expect(
      leadingParallelRun(calls, (name) => manager.getToolBehavior(name)),
    ).toHaveLength(2);
    delete handle.config.toolBehavior;
    expect(
      leadingParallelRun(calls, (name) => manager.getToolBehavior(name)),
    ).toHaveLength(0);
    handle.healthy = false;
    internals.rebuildToolIndex();
    expect(manager.getToolBehavior('mail__lookup')).toBeUndefined();
  });

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

describe('McpClientManager deferred loading', () => {
  // MAX_LOADED_SERVER_SCHEMA_CHARS in container/src/mcp/client-manager.ts.
  const BUDGET = 32_000;

  type DeferralInternals = {
    configs: Map<string, McpServerConfig>;
    clients: Map<string, McpClientHandle>;
    mapTools(
      serverName: string,
      serverNamespace: string,
      tools: Array<Record<string, unknown>>,
      seenNames: Set<string>,
    ): McpClientHandle['tools'];
    rebuildToolIndex(): void;
    getAllToolDefinitions(): ToolDefinition[];
    getDeferLoadingToolNames(requestTools: ToolDefinition[]): string[];
  };

  /**
   * Servers whose unmarked tools serialize to exactly `chars` characters as
   * the model receives them, plus `marked` tools that carry the _meta hint.
   */
  function managerWithServers(
    servers: Array<{
      name: string;
      count: number;
      chars: number;
      marked?: number;
    }>,
  ): DeferralInternals {
    const manager = new McpClientManager() as unknown as DeferralInternals;
    for (const { name, count, chars, marked = 0 } of servers) {
      const tools = manager.mapTools(
        name,
        name,
        Array.from({ length: count + marked }, (_, index) => ({
          name: `tool_${String(index).padStart(2, '0')}`,
          description: 'Does one thing.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: '' } },
          },
          ...(index >= count
            ? { _meta: { [DEFER_LOADING_META]: true } }
            : {}),
        })),
        new Set(),
      );
      manager.configs.set(name, makeConfig('node'));
      manager.clients.set(name, { ...makeHandle(name, 'unused'), tools });
      const unmarked = tools.filter((tool) => !tool.deferLoading);
      const loaded = () =>
        manager
          .getAllToolDefinitions()
          .filter((tool) =>
            unmarked.some((entry) => entry.name === tool.function.name),
          )
          .reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
      const extra = chars - loaded();
      unmarked.forEach((tool, index) => {
        const properties = tool.inputSchema.properties as Record<
          string,
          { description: string }
        >;
        properties.query.description = 'x'.repeat(
          Math.floor(extra / count) + (index === 0 ? extra % count : 0),
        );
      });
      expect(loaded()).toBe(chars);
    }
    manager.rebuildToolIndex();
    return manager;
  }

  test('keeps the tools a server marks for loading only when needed', () => {
    const manager = new McpClientManager() as unknown as DeferralInternals;
    const tools = manager.mapTools(
      'hybridai',
      'hybridai',
      [
        { name: 'web_search', inputSchema: { type: 'object' } },
        {
          name: 'dm__search_products',
          inputSchema: { type: 'object' },
          _meta: { [DEFER_LOADING_META]: true },
        },
        {
          name: 'trivago__search',
          inputSchema: { type: 'object' },
          _meta: { [DEFER_LOADING_META]: 'yes' },
        },
      ],
      new Set(),
    );
    manager.clients.set('hybridai', {
      ...makeHandle('hybridai', 'unused'),
      tools,
    });

    expect(
      manager.getDeferLoadingToolNames(manager.getAllToolDefinitions()),
    ).toEqual(['hybridai__dm__search_products']);
  });

  test.each([
    ['at the budget stays loaded', BUDGET, []],
    [
      'one character over it is deferred entirely',
      BUDGET + 1,
      ['invoice__tool_00', 'invoice__tool_01', 'invoice__tool_02'],
    ],
  ])('a server %s', (_label, chars, deferred) => {
    const manager = managerWithServers([
      { name: 'connectors', count: 4, chars: BUDGET - 100, marked: 2 },
      { name: 'invoice', count: 3, chars },
    ]);
    // Marked tools stay deferred either way and do not count toward the budget.
    expect(
      manager.getDeferLoadingToolNames(manager.getAllToolDefinitions()),
    ).toEqual(['connectors__tool_04', 'connectors__tool_05', ...deferred]);
  });

  test('sizes the tools the request offers, not the whole server', () => {
    const manager = managerWithServers([
      { name: 'invoice', count: 4, chars: 40_000 },
    ]);
    const all = manager.getAllToolDefinitions();
    expect(manager.getDeferLoadingToolNames(all)).toHaveLength(4);
    // An agent allowed three of the four tools sends ~30K: they stay loaded.
    expect(manager.getDeferLoadingToolNames(all.slice(1))).toEqual([]);
  });

  test('every worker exposes the same sorted tools, whatever the connect order', () => {
    const bash: ToolDefinition = {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a command.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    };
    const servers = [
      { name: 'connectors', count: 5, chars: 25_000 },
      { name: 'invoice', count: 8, chars: 56_000 },
    ];
    const exposed = [servers, [...servers].reverse()].map((order) => {
      const manager = managerWithServers(order);
      const tools = [bash, ...manager.getAllToolDefinitions()].sort(
        (a, b) => a.function.name.localeCompare(b.function.name),
      );
      const catalog = ToolCatalog.deferring(
        tools,
        new Set(manager.getDeferLoadingToolNames(tools)),
      );
      return {
        tools: JSON.stringify(catalog?.tools),
        guidance: catalog?.promptGuidance(),
      };
    });
    expect(exposed[1]).toEqual(exposed[0]);
    const names = (JSON.parse(exposed[0].tools) as ToolDefinition[]).map(
      (entry) => entry.function.name,
    );
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).not.toContain('connectors__tool_00');
    expect(names).toContain('bash');
    expect(exposed[0].guidance).toContain('- connectors__tool_00(query?)');
    expect(names).not.toContain('invoice__tool_00');
    expect(exposed[0].guidance).toContain('- invoice__tool_07(query?)');
  });
});
