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
        options: expect.arrayContaining([
          expect.objectContaining({
            kind: 'subcommand',
            name: 'list',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'config',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'install',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'reinstall',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'reload',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'uninstall',
          }),
        ]),
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

test('parses /plugin reload into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs } = await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: () => null,
      getSubcommand: () => 'reload',
    }),
  ).toEqual(['plugin', 'reload']);
});

test('parses /plugin config into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs, mapCanonicalCommandToGatewayArgs } =
    await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: (name) =>
        name === 'id'
          ? 'qmd-memory'
          : name === 'key'
            ? 'searchMode'
            : name === 'value'
              ? 'query'
              : null,
      getSubcommand: () => 'config',
    }),
  ).toEqual(['plugin', 'config', 'qmd-memory', 'searchMode', 'query']);
  expect(
    mapCanonicalCommandToGatewayArgs([
      'plugin',
      'config',
      'qmd-memory',
      'searchMode',
      'query',
    ]),
  ).toEqual(['plugin', 'config', 'qmd-memory', 'searchMode', 'query']);
});

test('parses /plugin install into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs, mapCanonicalCommandToGatewayArgs } =
    await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: (name) => (name === 'source' ? './plugins/qmd-memory' : null),
      getSubcommand: () => 'install',
    }),
  ).toEqual(['plugin', 'install', './plugins/qmd-memory']);
  expect(
    mapCanonicalCommandToGatewayArgs([
      'plugin',
      'install',
      './plugins/qmd-memory',
    ]),
  ).toEqual(['plugin', 'install', './plugins/qmd-memory']);
});

test('parses /plugin reinstall into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs, mapCanonicalCommandToGatewayArgs } =
    await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: (name) => (name === 'source' ? './plugins/qmd-memory' : null),
      getSubcommand: () => 'reinstall',
    }),
  ).toEqual(['plugin', 'reinstall', './plugins/qmd-memory']);
  expect(
    mapCanonicalCommandToGatewayArgs([
      'plugin',
      'reinstall',
      './plugins/qmd-memory',
    ]),
  ).toEqual(['plugin', 'reinstall', './plugins/qmd-memory']);
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
