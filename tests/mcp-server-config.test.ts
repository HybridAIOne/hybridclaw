import { expect, test } from 'vitest';
import { parseMcpToolBehaviorConfig } from '../container/shared/mcp-server-config.js';
import { parseMcpServerConfig } from '../src/mcp/server-config.js';

test('preserves trusted scheduling declarations without enabling trust by default', () => {
  expect(parseMcpToolBehaviorConfig(undefined)).toBeUndefined();
  const toolBehavior = {
    trustAnnotations: true,
    overrides: { lookup: 'read-only', send: 'mutation' },
  };
  const config = parseMcpServerConfig(
    JSON.stringify({ transport: 'stdio', command: 'node', toolBehavior }),
  );
  expect(config.error).toBeUndefined();
  expect(config.config?.toolBehavior).toEqual(toolBehavior);
});

test.each([
  null,
  true,
  [],
  { trustAnnotations: 'true' },
  { trusted: true },
  { overrides: [] },
  { overrides: { lookup: true } },
  { overrides: { '': 'read-only' } },
])('rejects malformed declarations: %j', (toolBehavior) => {
  expect(() => parseMcpToolBehaviorConfig(toolBehavior)).toThrow();
  expect(
    parseMcpServerConfig(
      JSON.stringify({ transport: 'stdio', command: 'node', toolBehavior }),
    ).error,
  ).toBeTruthy();
});
