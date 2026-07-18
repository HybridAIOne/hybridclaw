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

describe('McpClientManager prompt schema compaction', () => {
  type ToolFunction = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };

  function toolDefinitionsFor(
    inputSchema: Record<string, unknown>,
    description = 'Update a contact',
  ): ToolFunction[] {
    const manager = new McpClientManager() as unknown as {
      configs: Map<string, McpServerConfig>;
      clients: Map<string, McpClientHandle>;
      rebuildToolIndex(): void;
      getAllToolDefinitions(): Array<{ function: ToolFunction }>;
    };
    manager.configs.set('zoho', makeConfig('node'));
    const handle = makeHandle('zoho', 'update_contact');
    handle.tools[0].description = description;
    handle.tools[0].inputSchema = inputSchema;
    manager.clients.set('zoho', handle);
    manager.rebuildToolIndex();
    return manager.getAllToolDefinitions().map((entry) => entry.function);
  }

  test('strips schema-position metadata and truncates long descriptions', () => {
    const [tool] = toolDefinitionsFor({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'UpdateContactInput',
      type: 'object',
      description: 'x'.repeat(500),
      properties: {
        contact_id: {
          type: 'string',
          title: 'Contact ID',
          description: 'y'.repeat(500),
          examples: ['123'],
        },
      },
      required: ['contact_id'],
    });

    expect(tool.parameters.$schema).toBeUndefined();
    expect(tool.parameters.title).toBeUndefined();
    expect(String(tool.parameters.description)).toHaveLength(200);
    expect(String(tool.parameters.description).endsWith('…')).toBe(true);
    const contactId = (
      tool.parameters.properties as Record<string, Record<string, unknown>>
    ).contact_id;
    expect(contactId.title).toBeUndefined();
    expect(contactId.examples).toBeUndefined();
    expect(String(contactId.description)).toHaveLength(200);
    expect(tool.parameters.required).toEqual(['contact_id']);
  });

  test('keeps properties literally named like schema metadata', () => {
    const [tool] = toolDefinitionsFor({
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title' },
        description: { type: 'string' },
        examples: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    });

    const properties = tool.parameters.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.title).toEqual({
      type: 'string',
      description: 'Issue title',
    });
    expect(properties.description).toEqual({ type: 'string' });
    expect(properties.examples).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  test('caps tool descriptions for the prompt', () => {
    const [tool] = toolDefinitionsFor(
      { type: 'object', properties: {} },
      `Update a contact. ${'z'.repeat(1000)}`,
    );

    expect(tool.description).toHaveLength(600);
    expect(tool.description.endsWith('…')).toBe(true);
  });
});
