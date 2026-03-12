import { expect, test } from 'vitest';

import {
  mapTuiSlashCommandToGatewayArgs,
  parseTuiSlashCommand,
} from '../src/tui-slash-command.js';

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

test('parses non-MCP slash commands into gateway-ready tokens', () => {
  const parsed = parseTuiSlashCommand('/model default gpt-5');

  expect(parsed.cmd).toBe('model');
  expect(parsed.parts).toEqual(['model', 'default', 'gpt-5']);
});

test('preserves quoted cron specs for /schedule add', () => {
  const parsed = parseTuiSlashCommand('/schedule add "*/5 * * * *" check logs');

  expect(parsed.cmd).toBe('schedule');
  expect(parsed.parts).toEqual([
    'schedule',
    'add',
    '"*/5 * * * *"',
    'check',
    'logs',
  ]);
});

test('defaults bare /mcp to the mcp command', () => {
  const parsed = parseTuiSlashCommand('/mcp');

  expect(parsed.cmd).toBe('mcp');
  expect(parsed.parts).toEqual(['mcp']);
});

test('maps Discord-style slash commands to gateway command args', () => {
  expect(mapTuiSlashCommandToGatewayArgs(['status'])).toEqual(['status']);
  expect(mapTuiSlashCommandToGatewayArgs(['channel-mode', 'free'])).toEqual([
    'channel',
    'mode',
    'free',
  ]);
  expect(mapTuiSlashCommandToGatewayArgs(['export', 'session-1'])).toEqual([
    'export',
    'session',
    'session-1',
  ]);
  expect(
    mapTuiSlashCommandToGatewayArgs(['agent', 'create', 'research', 'gpt-5']),
  ).toEqual(['agent', 'create', 'research', '--model', 'gpt-5']);
  expect(mapTuiSlashCommandToGatewayArgs(['bot', 'list'])).toEqual([
    'bot',
    'list',
  ]);
});
