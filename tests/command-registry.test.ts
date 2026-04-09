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
  const {
    buildCanonicalSlashCommandDefinitions,
    buildTuiSlashCommandDefinitions,
    isRegisteredTextCommandName,
  } = await importCommandRegistry();
  expect(isRegisteredTextCommandName('plugin')).toBe(true);
  expect(isRegisteredTextCommandName('concierge')).toBe(true);
  expect(isRegisteredTextCommandName('dream')).toBe(true);

  expect(buildCanonicalSlashCommandDefinitions([])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'concierge',
        options: expect.arrayContaining([
          expect.objectContaining({
            kind: 'subcommand',
            name: 'info',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'on',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'off',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'model',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'profile',
          }),
        ]),
      }),
      expect.objectContaining({
        name: 'plugin',
        options: expect.arrayContaining([
          expect.objectContaining({
            kind: 'subcommand',
            name: 'list',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'enable',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'disable',
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
  expect(
    buildCanonicalSlashCommandDefinitions([]).some(
      (definition) => definition.name === 'dream',
    ),
  ).toBe(false);
  expect(buildTuiSlashCommandDefinitions([])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'dream',
        options: expect.arrayContaining([
          expect.objectContaining({
            kind: 'subcommand',
            name: 'now',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'on',
          }),
          expect.objectContaining({
            kind: 'subcommand',
            name: 'off',
          }),
        ]),
      }),
    ]),
  );
});

test('registers agent install as a canonical and local slash/text command', async () => {
  const {
    buildCanonicalSlashCommandDefinitions,
    buildTuiSlashCommandDefinitions,
    isRegisteredTextCommandName,
    parseCanonicalSlashCommandArgs,
  } = await importCommandRegistry();

  expect(isRegisteredTextCommandName('agent')).toBe(true);
  expect(buildCanonicalSlashCommandDefinitions([])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'agent',
        options: expect.arrayContaining([
          expect.objectContaining({
            kind: 'subcommand',
            name: 'install',
          }),
        ]),
      }),
    ]),
  );
  expect(buildTuiSlashCommandDefinitions([])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'agent',
        options: expect.arrayContaining([
          expect.objectContaining({
            kind: 'subcommand',
            name: 'install',
          }),
        ]),
      }),
    ]),
  );

  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'agent',
      getString: (name) =>
        name === 'source'
          ? 'official:charly'
          : name === 'id'
            ? 'research'
            : name === 'force'
              ? '--force'
              : name === 'skip-skill-scan'
                ? '--skip-skill-scan'
                : name === 'skip-externals'
                  ? '--skip-externals'
                  : name === 'skip-import-errors'
                    ? '--skip-import-errors'
                    : name === 'yes'
                      ? '--yes'
                      : null,
      getSubcommand: () => 'install',
    }),
  ).toEqual([
    'agent',
    'install',
    'official:charly',
    '--id',
    'research',
    '--force',
    '--skip-skill-scan',
    '--skip-externals',
    '--skip-import-errors',
    '--yes',
  ]);
});

test('registers auth as a local slash/text command', async () => {
  const {
    buildCanonicalSlashCommandDefinitions,
    buildTuiSlashCommandDefinitions,
    isRegisteredTextCommandName,
    parseCanonicalSlashCommandArgs,
    mapCanonicalCommandToGatewayArgs,
  } = await importCommandRegistry();
  expect(isRegisteredTextCommandName('auth')).toBe(true);
  expect(
    buildCanonicalSlashCommandDefinitions([]).some(
      (definition) => definition.name === 'auth',
    ),
  ).toBe(false);
  expect(buildTuiSlashCommandDefinitions([])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'auth',
        options: expect.arrayContaining([
          expect.objectContaining({
            kind: 'subcommand',
            name: 'status',
          }),
        ]),
      }),
    ]),
  );
  const authDefinition = buildTuiSlashCommandDefinitions([]).find(
    (definition) => definition.name === 'auth',
  );
  const authStatusDefinition = authDefinition?.options?.find(
    (option) => option.kind === 'subcommand' && option.name === 'status',
  );
  const providerOption = authStatusDefinition?.options?.find(
    (option) => option.kind === 'string' && option.name === 'provider',
  );
  expect(providerOption).toEqual(
    expect.objectContaining({
      kind: 'string',
      name: 'provider',
      required: true,
    }),
  );
  expect(providerOption?.choices).toBeUndefined();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'auth',
      getString: (name) => (name === 'provider' ? 'hybridai' : null),
      getSubcommand: () => 'status',
    }),
  ).toEqual(['auth', 'status', 'hybridai']);
  expect(
    mapCanonicalCommandToGatewayArgs(['auth', 'status', 'hybridai']),
  ).toEqual(['auth', 'status', 'hybridai']);
});

test('registers eval as a local slash/text command', async () => {
  const {
    buildCanonicalSlashCommandDefinitions,
    buildTuiSlashCommandDefinitions,
    isRegisteredTextCommandName,
    mapCanonicalCommandToGatewayArgs,
  } = await importCommandRegistry();
  expect(isRegisteredTextCommandName('eval')).toBe(true);
  expect(
    buildCanonicalSlashCommandDefinitions([]).some(
      (definition) => definition.name === 'eval',
    ),
  ).toBe(false);
  expect(buildTuiSlashCommandDefinitions([])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'eval',
        tuiMenuEntries: expect.arrayContaining([
          expect.objectContaining({
            label: '/eval list',
          }),
          expect.objectContaining({
            label: '/eval swebench-verified',
          }),
        ]),
      }),
    ]),
  );
  expect(mapCanonicalCommandToGatewayArgs(['eval', 'gaia'])).toEqual([
    'eval',
    'gaia',
  ]);
});

test('registers config as a local slash/text command', async () => {
  const {
    buildCanonicalSlashCommandDefinitions,
    buildTuiSlashCommandDefinitions,
    isRegisteredTextCommandName,
    parseCanonicalSlashCommandArgs,
    mapCanonicalCommandToGatewayArgs,
  } = await importCommandRegistry();
  expect(isRegisteredTextCommandName('config')).toBe(true);
  expect(
    buildCanonicalSlashCommandDefinitions([]).some(
      (definition) => definition.name === 'config',
    ),
  ).toBe(false);
  expect(buildTuiSlashCommandDefinitions([])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'config',
      }),
    ]),
  );
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'config',
      getString: () => null,
      getSubcommand: () => null,
    }),
  ).toEqual(['config']);
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'config',
      getString: (name) => (name === 'action' ? 'check' : null),
      getSubcommand: () => null,
    }),
  ).toEqual(['config', 'check']);
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'config',
      getString: (name) => (name === 'action' ? 'reload' : null),
      getSubcommand: () => null,
    }),
  ).toEqual(['config', 'reload']);
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'config',
      getString: (name) =>
        name === 'action'
          ? 'set'
          : name === 'key'
            ? 'hybridai.maxTokens'
            : name === 'value'
              ? '8192'
              : null,
      getSubcommand: () => null,
    }),
  ).toEqual(['config', 'set', 'hybridai.maxTokens', '8192']);
  expect(mapCanonicalCommandToGatewayArgs(['config'])).toEqual(['config']);
  expect(mapCanonicalCommandToGatewayArgs(['config', 'check'])).toEqual([
    'config',
    'check',
  ]);
  expect(mapCanonicalCommandToGatewayArgs(['config', 'reload'])).toEqual([
    'config',
    'reload',
  ]);
  expect(
    mapCanonicalCommandToGatewayArgs([
      'config',
      'set',
      'hybridai.maxTokens',
      '8192',
    ]),
  ).toEqual(['config', 'set', 'hybridai.maxTokens', '8192']);
});

test('registers secret as a local slash/text command', async () => {
  const {
    buildCanonicalSlashCommandDefinitions,
    buildTuiSlashCommandDefinitions,
    isRegisteredTextCommandName,
    parseCanonicalSlashCommandArgs,
    mapCanonicalCommandToGatewayArgs,
  } = await importCommandRegistry();
  expect(isRegisteredTextCommandName('secret')).toBe(true);
  expect(
    buildCanonicalSlashCommandDefinitions([]).some(
      (definition) => definition.name === 'secret',
    ),
  ).toBe(false);
  expect(buildTuiSlashCommandDefinitions([])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'secret',
      }),
    ]),
  );
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'secret',
      getString: () => null,
      getSubcommand: () => null,
    }),
  ).toEqual(['secret']);
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'secret',
      getString: (name) =>
        name === 'action'
          ? 'set'
          : name === 'name'
            ? 'STAGING_HYBRIDAI_API_KEY'
            : name === 'value'
              ? 'demo_key_2024'
              : null,
      getSubcommand: () => null,
    }),
  ).toEqual(['secret', 'set', 'STAGING_HYBRIDAI_API_KEY', 'demo_key_2024']);
  expect(mapCanonicalCommandToGatewayArgs(['secret'])).toEqual(['secret']);
  expect(
    mapCanonicalCommandToGatewayArgs([
      'secret',
      'set',
      'STAGING_HYBRIDAI_API_KEY',
      'demo_key_2024',
    ]),
  ).toEqual(['secret', 'set', 'STAGING_HYBRIDAI_API_KEY', 'demo_key_2024']);
});

test('parses /concierge profile into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs, mapCanonicalCommandToGatewayArgs } =
    await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'concierge',
      getString: (name) =>
        name === 'profile'
          ? 'no_hurry'
          : name === 'model'
            ? 'ollama/qwen3:latest'
            : null,
      getSubcommand: () => 'profile',
    }),
  ).toEqual(['concierge', 'profile', 'no_hurry', 'ollama/qwen3:latest']);
  expect(
    mapCanonicalCommandToGatewayArgs([
      'concierge',
      'profile',
      'no_hurry',
      'ollama/qwen3:latest',
    ]),
  ).toEqual(['concierge', 'profile', 'no_hurry', 'ollama/qwen3:latest']);
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

test('registers dream as a local slash/text command', async () => {
  const {
    buildCanonicalSlashCommandDefinitions,
    buildTuiSlashCommandDefinitions,
    isRegisteredTextCommandName,
    mapCanonicalCommandToGatewayArgs,
    parseCanonicalSlashCommandArgs,
  } = await importCommandRegistry();

  expect(isRegisteredTextCommandName('dream')).toBe(true);
  expect(
    buildCanonicalSlashCommandDefinitions([]).some(
      (definition) => definition.name === 'dream',
    ),
  ).toBe(false);
  expect(
    buildTuiSlashCommandDefinitions([]).some(
      (definition) => definition.name === 'dream',
    ),
  ).toBe(true);
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'dream',
      getString: () => null,
      getSubcommand: () => 'now',
    }),
  ).toEqual(['dream', 'now']);
  expect(mapCanonicalCommandToGatewayArgs(['dream'])).toEqual(['dream']);
  expect(mapCanonicalCommandToGatewayArgs(['dream', 'on'])).toEqual([
    'dream',
    'on',
  ]);
  expect(mapCanonicalCommandToGatewayArgs(['dream', 'off'])).toEqual([
    'dream',
    'off',
  ]);
  expect(mapCanonicalCommandToGatewayArgs(['dream', 'now'])).toEqual([
    'dream',
    'now',
  ]);
});

test('maps bot clear and bot auto to the clear gateway command', async () => {
  const { mapCanonicalCommandToGatewayArgs } = await importCommandRegistry();

  expect(mapCanonicalCommandToGatewayArgs(['bot', 'clear'])).toEqual([
    'bot',
    'clear',
  ]);
  expect(mapCanonicalCommandToGatewayArgs(['bot', 'auto'])).toEqual([
    'bot',
    'clear',
  ]);
});

test('parses /plugin disable into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs, mapCanonicalCommandToGatewayArgs } =
    await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: (name) => (name === 'id' ? 'qmd-memory' : null),
      getSubcommand: () => 'disable',
    }),
  ).toEqual(['plugin', 'disable', 'qmd-memory']);
  expect(
    mapCanonicalCommandToGatewayArgs(['plugin', 'disable', 'qmd-memory']),
  ).toEqual(['plugin', 'disable', 'qmd-memory']);
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
      getString: (name) =>
        name === 'source'
          ? './plugins/qmd-memory'
          : name === 'yes'
            ? '--yes'
            : null,
      getSubcommand: () => 'install',
    }),
  ).toEqual(['plugin', 'install', './plugins/qmd-memory', '--yes']);
  expect(
    mapCanonicalCommandToGatewayArgs([
      'plugin',
      'install',
      './plugins/qmd-memory',
      '--yes',
    ]),
  ).toEqual(['plugin', 'install', './plugins/qmd-memory', '--yes']);
});

test('parses /plugin reinstall into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs, mapCanonicalCommandToGatewayArgs } =
    await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: (name) =>
        name === 'source'
          ? './plugins/qmd-memory'
          : name === 'yes'
            ? '--yes'
            : null,
      getSubcommand: () => 'reinstall',
    }),
  ).toEqual(['plugin', 'reinstall', './plugins/qmd-memory', '--yes']);
  expect(
    mapCanonicalCommandToGatewayArgs([
      'plugin',
      'reinstall',
      './plugins/qmd-memory',
      '--yes',
    ]),
  ).toEqual(['plugin', 'reinstall', './plugins/qmd-memory', '--yes']);
});

test('parses /plugin check into gateway args', async () => {
  const { parseCanonicalSlashCommandArgs, mapCanonicalCommandToGatewayArgs } =
    await importCommandRegistry();
  expect(
    parseCanonicalSlashCommandArgs({
      commandName: 'plugin',
      getString: (name) => (name === 'plugin-id' ? 'mempalace-memory' : null),
      getSubcommand: () => 'check',
    }),
  ).toEqual(['plugin', 'check', 'mempalace-memory']);
  expect(
    mapCanonicalCommandToGatewayArgs(['plugin', 'check', 'mempalace-memory']),
  ).toEqual(['plugin', 'check', 'mempalace-memory']);
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

test('builds local session help entries from the registry with surface filtering', async () => {
  const { buildLocalSessionSlashHelpEntries } = await importCommandRegistry();

  const tuiHelp = buildLocalSessionSlashHelpEntries('tui');
  const webHelp = buildLocalSessionSlashHelpEntries('web');
  const compareCommands = (left: string, right: string) =>
    left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: 'base',
    });

  expect(tuiHelp).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        command: '/auth status <provider>',
      }),
      expect.objectContaining({
        command: '/config [check|reload|set <key> <value>]',
      }),
      expect.objectContaining({
        command: '/paste',
      }),
      expect.objectContaining({
        command: '/exit',
      }),
    ]),
  );
  expect(webHelp).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        command: '/auth status <provider>',
      }),
      expect.objectContaining({
        command: '/config [check|reload|set <key> <value>]',
      }),
    ]),
  );
  expect(webHelp.some((entry) => entry.command === '/paste')).toBe(false);
  expect(webHelp.some((entry) => entry.command === '/exit')).toBe(false);
  expect(tuiHelp.map((entry) => entry.command)).toEqual(
    [...tuiHelp.map((entry) => entry.command)].sort(compareCommands),
  );
  expect(webHelp.map((entry) => entry.command)).toEqual(
    [...webHelp.map((entry) => entry.command)].sort(compareCommands),
  );
});
