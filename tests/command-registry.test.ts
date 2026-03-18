import { expect, test } from 'vitest';

import {
  buildCanonicalSlashCommandDefinitions,
  isRegisteredTextCommandName,
  parseCanonicalSlashCommandArgs,
} from '../src/command-registry.js';

test('registers plugin as a slash/text command', () => {
  expect(isRegisteredTextCommandName('plugin')).toBe(true);

  expect(buildCanonicalSlashCommandDefinitions([])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'plugin',
        options: [
          expect.objectContaining({
            kind: 'subcommand',
            name: 'list',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'uninstall',
          }),
        ],
      }),
    ]),
  );
});

test('parses /plugin list into gateway args', () => {
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: () => null,
      getSubcommand: () => 'list',
    }),
  ).toEqual(['plugin', 'list']);
});

test('parses /plugin uninstall into gateway args', () => {
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: (name) => (name === 'id' ? 'demo-plugin' : null),
      getSubcommand: () => 'uninstall',
    }),
  ).toEqual(['plugin', 'uninstall', 'demo-plugin']);
});
