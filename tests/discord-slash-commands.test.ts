import { ApplicationIntegrationType, InteractionContextType } from 'discord.js';
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
  const modelDefinition = definitions.find(
    (definition) => definition.name === 'model',
  );

  expect(names).toEqual(
    new Set([
      'status',
      'approve',
      'compact',
      'channel-mode',
      'channel-policy',
      'model',
      'agent',
      'help',
      'bot',
      'rag',
      'ralph',
      'mcp',
      'clear',
      'reset',
      'usage',
      'export',
      'sessions',
      'audit',
      'schedule',
    ]),
  );
  expect(
    definitions.every(
      (definition) =>
        definition.integrationTypes?.length === 1 &&
        definition.integrationTypes[0] ===
          ApplicationIntegrationType.GuildInstall,
    ),
  ).toBe(true);
  expect(
    definitions.every(
      (definition) =>
        JSON.stringify(definition.contexts) ===
        JSON.stringify([
          InteractionContextType.Guild,
          InteractionContextType.BotDM,
          InteractionContextType.PrivateChannel,
        ]),
    ),
  ).toBe(true);
  expect(
    modelDefinition?.options
      ?.map((option) => ('name' in option ? option.name : ''))
      .filter(Boolean),
  ).toEqual(['info', 'list', 'set', 'default']);
});

test('parseSlashInteractionArgs maps agent interactions to command args', () => {
  const listArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'agent',
      subcommand: 'list',
    }) as never,
  );
  const switchArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'agent',
      subcommand: 'switch',
      strings: { id: 'research' },
    }) as never,
  );
  const createArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'agent',
      subcommand: 'create',
      strings: { id: 'research', model: 'gpt-5' },
    }) as never,
  );

  expect(listArgs).toEqual(['agent', 'list']);
  expect(switchArgs).toEqual(['agent', 'switch', 'research']);
  expect(createArgs).toEqual([
    'agent',
    'create',
    'research',
    '--model',
    'gpt-5',
  ]);
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

test('parseSlashInteractionArgs maps model list, set, and default interactions', () => {
  const listArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'model',
      subcommand: 'list',
    }) as never,
  );
  const setArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'model',
      subcommand: 'set',
      strings: { name: 'lmstudio/qwen/qwen3.5-9b' },
    }) as never,
  );
  const defaultArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'model',
      subcommand: 'default',
      strings: {},
    }) as never,
  );
  const infoArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'model',
      subcommand: 'info',
    }) as never,
  );

  expect(listArgs).toEqual(['model', 'list']);
  expect(setArgs).toEqual(['model', 'set', 'lmstudio/qwen/qwen3.5-9b']);
  expect(defaultArgs).toEqual(['model', 'default']);
  expect(infoArgs).toEqual(['model', 'info']);
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

test('parseSlashInteractionArgs maps usage model window filters', () => {
  const usageArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'usage',
      strings: {
        view: 'model',
        window: 'daily',
        agent_id: 'agent-42',
      },
    }) as never,
  );

  expect(usageArgs).toEqual(['usage', 'model', 'daily', 'agent-42']);
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

test('parseSlashInteractionArgs maps reset interactions to command args', () => {
  const promptArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'reset',
      strings: {},
    }) as never,
  );
  const confirmArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'reset',
      strings: { confirm: 'yes' },
    }) as never,
  );
  const cancelArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'reset',
      strings: { confirm: 'no' },
    }) as never,
  );

  expect(promptArgs).toEqual(['reset']);
  expect(confirmArgs).toEqual(['reset', 'yes']);
  expect(cancelArgs).toEqual(['reset', 'no']);
});

test('slash commands parse in DMs and guilds the same way', () => {
  const helpArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'help',
      guildId: null,
    }) as never,
  );
  const mcpArgs = parseSlashInteractionArgs(
    makeInteraction({
      commandName: 'mcp',
      guildId: null,
      subcommand: 'list',
    }) as never,
  );

  expect(helpArgs).toEqual(['help']);
  expect(mcpArgs).toEqual(['mcp', 'list']);
  expect(isGlobalSlashCommand('status')).toBe(true);
  expect(isGlobalSlashCommand('help')).toBe(true);
});
