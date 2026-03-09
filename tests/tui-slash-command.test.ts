import { expect, test } from 'vitest';

import { parseTuiSlashCommand } from '../src/tui-slash-command.js';

test('preserves JSON payloads for /mcp add', () => {
  const parsed = parseTuiSlashCommand(
    '/mcp add github {"transport":"stdio","command":"docker","args":["run","-i","--rm","ghcr.io/github/github-mcp-server"]}',
  );

  expect(parsed.cmd).toBe('mcp');
  expect(parsed.parts).toEqual([
    'mcp',
    'add',
    'github',
    '{"transport":"stdio","command":"docker","args":["run","-i","--rm","ghcr.io/github/github-mcp-server"]}',
  ]);
});

test('parses non-MCP slash commands with whitespace splitting', () => {
  const parsed = parseTuiSlashCommand('/model default gpt-5');

  expect(parsed.cmd).toBe('model');
  expect(parsed.parts).toEqual(['model', 'default', 'gpt-5']);
});

test('defaults bare /mcp to the mcp command', () => {
  const parsed = parseTuiSlashCommand('/mcp');

  expect(parsed.cmd).toBe('mcp');
  expect(parsed.parts).toEqual(['mcp']);
});
