import { expect, test } from 'vitest';

import {
  buildSlashCommandDefinitions,
  isGlobalSlashCommand,
  parseSlashInteractionArgs,
} from '../src/channels/discord/slash-commands.js';

function makeInteraction(params: {
  commandName: string;
  guildId?: string | null;
  subcommand?: string | null;
  strings?: Record<string, string | undefined>;
}) {
  return {
    commandName: params.commandName,
    guildId: 'guildId' in params ? (params.guildId ?? null) : 'guild-1',
    options: {
      getString: (name: string) => params.strings?.[name] ?? null,
      getSubcommand: () => params.subcommand ?? null,
    },
  };
}

test('buildSlashCommandDefinitions includes the expanded Discord command set', () => {
  const definitions = buildSlashCommandDefinitions([
    { name: 'gpt-5', value: 'gpt-5' },
  ]);
  const names = new Set(definitions.map((definition) => definition.name));

  expect(names).toEqual(
    new Set([
      'status',
      'approve',
      'compact',
      'channel-mode',
      'channel-policy',
      'model',
      'help',
      'bot',
      'rag',
      'ralph',
      'mcp',
      'clear',
      'usage',
      'export',
      'sessions',
      'audit',
      'schedule',
    ]),
  );
});

test('parseSlashInteractionArgs maps bot set interactions to command args', () => {
  const args = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'bot',
      subcommand: 'set',
      strings: { name: 'mybot' },
    }) as never,
  );

  expect(args).toEqual(['bot', 'set', 'mybot']);
});

test('parseSlashInteractionArgs preserves quoted schedule add specs', () => {
  const args = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'schedule',
      subcommand: 'add',
      strings: { spec: '"*/5 * * * *" check logs' },
    }) as never,
  );

  expect(args).toEqual(['schedule', 'add', '"*/5 * * * *"', 'check', 'logs']);
});

test('parseSlashInteractionArgs maps usage model filters and export defaults', () => {
  const usageArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'usage',
      strings: { view: 'model', agent_id: 'agent-42' },
    }) as never,
  );
  const exportArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'export',
      strings: {},
    }) as never,
  );

  expect(usageArgs).toEqual(['usage', 'model', 'agent-42']);
  expect(exportArgs).toEqual(['export', 'session']);
});

test('parseSlashInteractionArgs maps approval and mcp add interactions to command args', () => {
  const approveArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'approve',
      strings: { action: 'session', approval_id: 'abc123' },
    }) as never,
  );
  const mcpArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'mcp',
      subcommand: 'add',
      strings: {
        name: 'github',
        config:
          '{"transport":"stdio","command":"docker","args":["run","-i","--rm","ghcr.io/github/github-mcp-server"]}',
      },
    }) as never,
  );

  expect(approveArgs).toEqual(['approve', 'session', 'abc123']);
  expect(mcpArgs).toEqual([
    'mcp',
    'add',
    'github',
    '{"transport":"stdio","command":"docker","args":["run","-i","--rm","ghcr.io/github/github-mcp-server"]}',
  ]);
});

test('guild-only slash commands are rejected in DMs while global ones still parse', () => {
  const helpArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'help',
      guildId: null,
    }) as never,
  );
  const statusArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'status',
      guildId: null,
    }) as never,
  );

  expect(helpArgs).toBeNull();
  expect(statusArgs).toEqual(['status']);
  expect(isGlobalSlashCommand('status')).toBe(true);
  expect(isGlobalSlashCommand('help')).toBe(false);
});
