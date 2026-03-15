import { expect, test } from 'vitest';

import {
  mapTuiApproveSlashToGatewayArgs,
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
  expect(mapTuiSlashCommandToGatewayArgs(['help'])).toEqual(['help']);
  expect(mapTuiSlashCommandToGatewayArgs(['h'])).toEqual(['help']);
  expect(mapTuiSlashCommandToGatewayArgs(['status'])).toEqual(['status']);
  expect(mapTuiSlashCommandToGatewayArgs(['model'])).toEqual(['model', 'info']);
  expect(
    mapTuiSlashCommandToGatewayArgs(['model', 'list', 'openrouter']),
  ).toEqual(['model', 'list', 'openrouter']);
  expect(mapTuiSlashCommandToGatewayArgs(['model', 'auto'])).toEqual([
    'model',
    'clear',
  ]);
  expect(mapTuiSlashCommandToGatewayArgs(['show', 'tools'])).toEqual([
    'show',
    'tools',
  ]);
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
  expect(
    mapTuiSlashCommandToGatewayArgs(['agent', 'model', 'gpt-5-mini']),
  ).toEqual(['agent', 'model', 'gpt-5-mini']);
  expect(mapTuiSlashCommandToGatewayArgs(['bot', 'list'])).toEqual([
    'bot',
    'list',
  ]);
});

test('maps /approve actions to explicit typed results', () => {
  expect(mapTuiApproveSlashToGatewayArgs(['approve', 'yes'], 'abc123')).toEqual({
    kind: 'args',
    args: ['approve', 'yes', 'abc123'],
  });
  expect(
    mapTuiApproveSlashToGatewayArgs(['approve', 'agent'], 'abc123'),
  ).toEqual({
    kind: 'args',
    args: ['approve', 'agent', 'abc123'],
  });
  expect(mapTuiApproveSlashToGatewayArgs(['approve', 'no'], 'abc123')).toEqual({
    kind: 'args',
    args: ['approve', 'no', 'abc123'],
  });
});

test('returns missing-approval instead of overloading empty strings', () => {
  expect(mapTuiApproveSlashToGatewayArgs(['approve', 'session'])).toEqual({
    kind: 'missing-approval',
  });
});

test('returns usage for invalid /approve actions', () => {
  expect(mapTuiApproveSlashToGatewayArgs(['approve', 'maybe'], 'abc123')).toEqual({
    kind: 'usage',
  });
});
