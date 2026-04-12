import { expect, test } from 'vitest';

import {
  buildSlackSlashCommandDefinitions,
  mergeSlackSlashCommandsIntoManifest,
  renderSlackSlashCommandManifest,
} from '../src/channels/slack/slash-commands.js';

test('buildSlackSlashCommandDefinitions includes canonical Slack commands', () => {
  const commands = buildSlackSlashCommandDefinitions();

  expect(commands.length).toBeGreaterThan(5);
  expect(commands.some((command) => command.command === '/status')).toBe(true);
  expect(new Set(commands.map((command) => command.command)).size).toBe(
    commands.length,
  );
});

test('mergeSlackSlashCommandsIntoManifest preserves unrelated commands', () => {
  const merged = mergeSlackSlashCommandsIntoManifest({
    display_information: { name: 'HybridClaw Dev' },
    oauth_config: {
      scopes: {
        bot: ['chat:write'],
      },
    },
    features: {
      slash_commands: [
        {
          command: '/custom',
          description: 'Custom command',
          should_escape: true,
        },
        {
          command: '/status',
          description: 'Old status',
          should_escape: true,
        },
      ],
    },
  });

  expect(merged.oauth_config).toMatchObject({
    scopes: {
      bot: ['chat:write', 'commands'],
    },
  });
  expect(merged.features).toMatchObject({
    slash_commands: expect.arrayContaining([
      expect.objectContaining({
        command: '/custom',
        description: 'Custom command',
      }),
      expect.objectContaining({
        command: '/status',
        description: 'Show HybridClaw runtime status (only visible to you)',
        should_escape: false,
      }),
    ]),
  });
});

test('renderSlackSlashCommandManifest renders yaml with commands scope', () => {
  const output = renderSlackSlashCommandManifest('yaml');

  expect(output).toContain('oauth_config:');
  expect(output).toContain('- "commands"');
  expect(output).toContain('command: "/status"');
});
