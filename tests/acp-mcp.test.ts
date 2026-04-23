import { expect, test } from 'vitest';

import { acpMcpServersToConfigMap } from '../src/acp/mcp.js';
import { mergeSessionMcpServers } from '../src/infra/mcp-server-config.js';

test('acpMcpServersToConfigMap converts stdio and remote MCP servers', () => {
  const servers = acpMcpServersToConfigMap([
    {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      env: [{ name: 'DEBUG', value: '1' }],
    },
    {
      type: 'http',
      name: 'github',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer test' }],
    },
    {
      type: 'sse',
      name: 'slack',
      url: 'https://example.com/sse',
      headers: [],
    },
  ]);

  expect(servers).toEqual({
    filesystem: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      env: { DEBUG: '1' },
    },
    github: {
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer test' },
    },
    slack: {
      transport: 'sse',
      url: 'https://example.com/sse',
    },
  });
});

test('mergeSessionMcpServers overlays runtime MCP config with ACP session overrides', () => {
  const merged = mergeSessionMcpServers(
    {
      filesystem: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      },
      github: {
        transport: 'http',
        url: 'https://runtime.example/mcp',
      },
    },
    {
      github: {
        transport: 'http',
        url: 'https://editor.example/mcp',
      },
      slack: {
        transport: 'sse',
        url: 'https://editor.example/sse',
      },
    },
  );

  expect(merged).toEqual({
    filesystem: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    },
    github: {
      transport: 'http',
      url: 'https://editor.example/mcp',
    },
    slack: {
      transport: 'sse',
      url: 'https://editor.example/sse',
    },
  });
});
