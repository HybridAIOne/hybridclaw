import { expect, test } from 'vitest';

import { isValidMcpServerName } from '../src/mcp/server-config.js';
import {
  buildTuiMcpServerConfig,
  parseTuiMcpArgsLine,
  parseTuiMcpKeyValuePairs,
  waitForTuiMcpOAuthConnection,
} from '../src/tui-mcp-wizard.js';

test('validates MCP server names', () => {
  expect(isValidMcpServerName('github')).toBe(true);
  expect(isValidMcpServerName('hf_server-1')).toBe(true);
  expect(isValidMcpServerName('Foo')).toBe(false);
  expect(isValidMcpServerName('foo bar')).toBe(false);
  expect(isValidMcpServerName('')).toBe(false);
});

test('parses comma separated KEY=VALUE pairs', () => {
  expect(parseTuiMcpKeyValuePairs('')).toBeUndefined();
  expect(parseTuiMcpKeyValuePairs('A=1, B=x=y')).toEqual({
    A: '1',
    B: 'x=y',
  });
  expect(() => parseTuiMcpKeyValuePairs('no-separator')).toThrow(
    /KEY=VALUE/,
  );
});

test('parses argument lines with quoted segments', () => {
  expect(parseTuiMcpArgsLine('run --label "hello world" -v')).toEqual([
    'run',
    '--label',
    'hello world',
    '-v',
  ]);
  expect(parseTuiMcpArgsLine('')).toEqual([]);
});

test('builds stdio configs from wizard answers', () => {
  expect(
    buildTuiMcpServerConfig({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      argsLine: '-y @modelcontextprotocol/server-filesystem /tmp',
      envPairs: 'DEBUG=1',
    }),
  ).toEqual({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { DEBUG: '1' },
  });
  expect(() =>
    buildTuiMcpServerConfig({ name: 'fs', transport: 'stdio' }),
  ).toThrow(/command/);
});

test('builds remote configs for each auth choice', () => {
  expect(
    buildTuiMcpServerConfig({
      name: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      authChoice: 'oauth',
    }),
  ).toEqual({
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
  });
  expect(
    buildTuiMcpServerConfig({
      name: 'tavily',
      transport: 'http',
      url: 'https://mcp.tavily.com/mcp',
      authChoice: 'bearer',
      bearerToken: 'tvly-123',
    }).headers,
  ).toEqual({ Authorization: 'Bearer tvly-123' });
  expect(
    buildTuiMcpServerConfig({
      name: 'custom',
      transport: 'sse',
      url: 'https://example.com/sse',
      authChoice: 'headers',
      headerPairs: 'X-Api-Key=k1',
    }).headers,
  ).toEqual({ 'X-Api-Key': 'k1' });
  expect(() =>
    buildTuiMcpServerConfig({
      name: 'bad',
      transport: 'http',
      url: 'not-a-url',
    }),
  ).toThrow(/http\(s\) URL/);
});

test('waitForTuiMcpOAuthConnection polls until connected', async () => {
  let now = 0;
  const states = ['unauthorized', 'unauthorized', 'connected'] as const;
  let call = 0;
  const status = await waitForTuiMcpOAuthConnection({
    name: 'linear',
    timeoutMs: 60_000,
    deps: {
      now: () => now,
      sleep: async () => {
        now += 2_000;
      },
      fetchOAuthStatus: async (name: string) => ({
        name,
        auth: { method: 'oauth', state: states[Math.min(call++, 2)] },
      }),
    },
  });
  expect(status?.auth.state).toBe('connected');
  expect(call).toBe(3);
});

test('waitForTuiMcpOAuthConnection gives up at the deadline', async () => {
  let now = 0;
  const status = await waitForTuiMcpOAuthConnection({
    name: 'linear',
    timeoutMs: 10_000,
    deps: {
      now: () => now,
      sleep: async () => {
        now += 2_000;
      },
      fetchOAuthStatus: async (name: string) => ({
        name,
        auth: { method: 'oauth' as const, state: 'unauthorized' as const },
      }),
    },
  });
  expect(status).toBeNull();
});
