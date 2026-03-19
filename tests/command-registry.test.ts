import { afterEach, expect, test, vi } from 'vitest';

async function importCommandRegistry() {
  return import('../src/command-registry.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/plugins/plugin-manager.js');
});

test('registers plugin as a slash/text command', async () => {
  const { buildCanonicalSlashCommandDefinitions, isRegisteredTextCommandName } =
    await importCommandRegistry();
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

test('parses /plugin list into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs } = await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: () => null,
      getSubcommand: () => 'list',
    }),
  ).toEqual(['plugin', 'list']);
});

test('parses /plugin uninstall into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs } = await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: (name) => (name === 'id' ? 'demo-plugin' : null),
      getSubcommand: () => 'uninstall',
    }),
  ).toEqual(['plugin', 'uninstall', 'demo-plugin']);
});

test('recognizes loaded plugin commands without hardcoding them in the registry', async () => {
  vi.doMock('../src/plugins/plugin-manager.js', () => ({
    findLoadedPluginCommand: vi.fn((name: string) =>
      name === 'qmd'
        ? {
            name: 'qmd',
            description: 'QMD status',
            handler: vi.fn(),
          }
        : undefined,
    ),
  }));

  const { isRegisteredTextCommandName, mapCanonicalCommandToGatewayArgs } =
    await importCommandRegistry();
  expect(isRegisteredTextCommandName('qmd')).toBe(true);
  expect(mapCanonicalCommandToGatewayArgs(['qmd'])).toEqual(['qmd']);
  expect(mapCanonicalCommandToGatewayArgs(['qmd', 'status'])).toEqual([
    'qmd',
    'status',
  ]);
});
