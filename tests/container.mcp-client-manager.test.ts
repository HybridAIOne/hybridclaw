import { describe, expect, test } from 'vitest';

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
