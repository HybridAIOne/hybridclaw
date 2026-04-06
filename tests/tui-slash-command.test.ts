import { expect, test } from 'vitest';

import {
  mapTuiApproveSlashToMessage,
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
  expect(
    mapTuiSlashCommandToGatewayArgs(['auth', 'status', 'hybridai']),
  ).toEqual(['auth', 'status', 'hybridai']);
  expect(mapTuiSlashCommandToGatewayArgs(['config'])).toEqual(['config']);
  expect(mapTuiSlashCommandToGatewayArgs(['config', 'check'])).toEqual([
    'config',
    'check',
  ]);
  expect(mapTuiSlashCommandToGatewayArgs(['config', 'reload'])).toEqual([
    'config',
    'reload',
  ]);
  expect(
    mapTuiSlashCommandToGatewayArgs([
      'secret',
      'set',
      'STAGING_HYBRIDAI_API_KEY',
      'demo_key_2024',
    ]),
  ).toEqual(['secret', 'set', 'STAGING_HYBRIDAI_API_KEY', 'demo_key_2024']);
  expect(
    mapTuiSlashCommandToGatewayArgs([
      'config',
      'set',
      'hybridai.maxTokens',
      '8192',
    ]),
  ).toEqual(['config', 'set', 'hybridai.maxTokens', '8192']);
  expect(mapTuiSlashCommandToGatewayArgs(['concierge'])).toEqual([
    'concierge',
    'info',
  ]);
  expect(
    mapTuiSlashCommandToGatewayArgs([
      'concierge',
      'profile',
      'no_hurry',
      'ollama/qwen3:latest',
    ]),
  ).toEqual(['concierge', 'profile', 'no_hurry', 'ollama/qwen3:latest']);
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
  expect(mapTuiSlashCommandToGatewayArgs(['export'])).toBeNull();
  expect(mapTuiSlashCommandToGatewayArgs(['export', 'session-1'])).toBeNull();
  expect(
    mapTuiSlashCommandToGatewayArgs(['export', 'session', 'session-1']),
  ).toEqual(['export', 'session', 'session-1']);
  expect(mapTuiSlashCommandToGatewayArgs(['export', 'trace'])).toEqual([
    'export',
    'trace',
  ]);
  expect(
    mapTuiSlashCommandToGatewayArgs(['export', 'trace', 'session-1']),
  ).toEqual(['export', 'trace', 'session-1']);
  expect(mapTuiSlashCommandToGatewayArgs(['export', 'trace', 'all'])).toEqual([
    'export',
    'trace',
    'all',
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
  expect(
    mapTuiSlashCommandToGatewayArgs(['skill', 'inspect', '--all']),
  ).toEqual(['skill', 'inspect', '--all']);
  expect(mapTuiSlashCommandToGatewayArgs(['skill', 'list'])).toEqual([
    'skill',
    'list',
  ]);
  expect(
    mapTuiSlashCommandToGatewayArgs(['skill', 'runs', 'demo-skill']),
  ).toEqual(['skill', 'runs', 'demo-skill']);
  expect(
    mapTuiSlashCommandToGatewayArgs(['skill', 'learn', 'demo-skill']),
  ).toEqual(['skill', 'learn', 'demo-skill']);
  expect(
    mapTuiSlashCommandToGatewayArgs([
      'skill',
      'learn',
      'demo-skill',
      '--apply',
    ]),
  ).toEqual(['skill', 'learn', 'demo-skill', '--apply']);
  expect(
    mapTuiSlashCommandToGatewayArgs(['skill', 'history', 'demo-skill']),
  ).toEqual(['skill', 'history', 'demo-skill']);
  expect(
    mapTuiSlashCommandToGatewayArgs(['skill', 'sync', 'official/datalion']),
  ).toEqual(['skill', 'sync', 'official/datalion']);
  expect(
    mapTuiSlashCommandToGatewayArgs(['skill', 'import', 'official/himalaya']),
  ).toEqual(['skill', 'import', 'official/himalaya']);
  expect(
    mapTuiSlashCommandToGatewayArgs([
      'skill',
      'import',
      '--force',
      'clawhub/brand-voice',
    ]),
  ).toEqual(['skill', 'import', '--force', 'clawhub/brand-voice']);
  expect(mapTuiSlashCommandToGatewayArgs(['plugin', 'list'])).toEqual([
    'plugin',
    'list',
  ]);
  expect(
    mapTuiSlashCommandToGatewayArgs([
      'plugin',
      'config',
      'qmd-memory',
      'searchMode',
      'query',
    ]),
  ).toEqual(['plugin', 'config', 'qmd-memory', 'searchMode', 'query']);
  expect(
    mapTuiSlashCommandToGatewayArgs([
      'plugin',
      'install',
      './plugins/qmd-memory',
    ]),
  ).toEqual(['plugin', 'install', './plugins/qmd-memory']);
  expect(
    mapTuiSlashCommandToGatewayArgs([
      'plugin',
      'reinstall',
      './plugins/qmd-memory',
    ]),
  ).toEqual(['plugin', 'reinstall', './plugins/qmd-memory']);
  expect(mapTuiSlashCommandToGatewayArgs(['plugin', 'reload'])).toEqual([
    'plugin',
    'reload',
  ]);
  expect(
    mapTuiSlashCommandToGatewayArgs(['plugin', 'disable', 'qmd-memory']),
  ).toEqual(['plugin', 'disable', 'qmd-memory']);
  expect(
    mapTuiSlashCommandToGatewayArgs(['plugin', 'uninstall', 'demo-plugin']),
  ).toEqual(['plugin', 'uninstall', 'demo-plugin']);
});

test('keeps explicit /skill invocations out of the slash-command path', () => {
  expect(mapTuiSlashCommandToGatewayArgs(['skill', 'config'])).toBeNull();
  expect(
    mapTuiSlashCommandToGatewayArgs(['skill', 'amend', 'demo-skill']),
  ).toBeNull();
  expect(mapTuiSlashCommandToGatewayArgs(['skill', 'demo-skill'])).toBeNull();
  expect(
    mapTuiSlashCommandToGatewayArgs(['skill', 'demo-skill', 'fix', 'tests']),
  ).toBeNull();
});

test('maps loaded plugin commands locally and leaves typos unresolved', () => {
  expect(mapTuiSlashCommandToGatewayArgs(['qmd', 'status'])).toBeNull();
  expect(
    mapTuiSlashCommandToGatewayArgs(['qmd', 'status'], {
      dynamicTextCommands: ['qmd'],
    }),
  ).toEqual(['qmd', 'status']);
  expect(
    mapTuiSlashCommandToGatewayArgs(['qmx', 'status'], {
      dynamicTextCommands: ['qmd'],
    }),
  ).toBeNull();
});

test('maps /approve actions to explicit typed results', () => {
  expect(mapTuiApproveSlashToMessage(['approve', 'yes'], 'abc123')).toEqual({
    kind: 'message',
    message: 'yes abc123',
  });
  expect(mapTuiApproveSlashToMessage(['approve', 'always'], 'abc123')).toEqual({
    kind: 'message',
    message: 'yes abc123 for session',
  });
  expect(mapTuiApproveSlashToMessage(['approve', 'all'], 'abc123')).toEqual({
    kind: 'message',
    message: 'yes abc123 for session',
  });
  expect(mapTuiApproveSlashToMessage(['approve', 'agent'], 'abc123')).toEqual({
    kind: 'message',
    message: 'yes abc123 for agent',
  });
  expect(mapTuiApproveSlashToMessage(['approve', 'no'], 'abc123')).toEqual({
    kind: 'message',
    message: 'skip abc123',
  });
});

test('returns missing-approval instead of overloading empty strings', () => {
  expect(mapTuiApproveSlashToMessage(['approve', 'session'])).toEqual({
    kind: 'missing-approval',
  });
});

test('returns usage for invalid /approve actions', () => {
  expect(mapTuiApproveSlashToMessage(['approve', 'maybe'], 'abc123')).toEqual({
    kind: 'usage',
  });
});
