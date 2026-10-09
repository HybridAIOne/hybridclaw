import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, test } from 'vitest';
import { useTempDir } from './test-utils.js';

// The real CLI (`node --import tsx src/cli.ts`) with a runtime home holding
// several installed plugins, most of them broken in the ways real installs
// break: register throws, a secret is unset, a binary is missing, two
// plugins claim one name. A plugin command's stdout must stay clean, and a
// name no manifest declares must not import any plugin code.
const makeTempDir = useTempDir('hybridclaw-plugin-cli-dispatch-');
const execFileAsync = promisify(execFile);

interface FixturePlugin {
  id: string;
  manifest: string;
  register: string;
}

const FIXTURE_PLUGINS: FixturePlugin[] = [
  {
    id: 'echo',
    manifest: [
      'cliCommands:',
      '  - name: echo-args',
      '    description: Print the arguments as JSON',
    ].join('\n'),
    register: `api.registerCliCommand({
      name: 'echo-args',
      run: (args) => { process.stdout.write(JSON.stringify(args) + '\\n'); },
    });`,
  },
  {
    id: 'throws',
    manifest: [
      'cliCommands:',
      '  - name: broken-cmd',
      '    description: Never loads',
    ].join('\n'),
    register: `throw new Error('boom');`,
  },
  {
    id: 'needs-secret',
    manifest: [
      'requires:',
      '  env: [PLUGIN_CLI_DISPATCH_TEST_UNSET_SECRET]',
    ].join('\n'),
    register: '',
  },
  {
    id: 'needs-bin',
    manifest: [
      'requires:',
      '  bins: [hybridclaw-test-missing-binary]',
    ].join('\n'),
    register: '',
  },
  ...['dup-a', 'dup-b'].map((id) => ({
    id,
    manifest: [
      'cliCommands:',
      '  - name: dup-cmd',
      '    description: Claimed twice',
    ].join('\n'),
    register: `api.registerCliCommand({ name: 'dup-cmd', run: () => {} });`,
  })),
];

function writeFixturePlugin(
  pluginsDir: string,
  markerDir: string,
  plugin: FixturePlugin,
): void {
  const dir = path.join(pluginsDir, plugin.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    `id: ${plugin.id}\nversion: 1.0.0\nentrypoint: index.js\n${plugin.manifest}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(markerDir, plugin.id))}, '');
export default {
  id: ${JSON.stringify(plugin.id)},
  register(api) {
    ${plugin.register}
  },
};
`,
  );
}

const TSX_LOADER = import.meta.resolve('tsx');
const CLI_ENTRY = path.resolve('src', 'cli.ts');

async function cli(
  home: string,
  args: string[],
  cwd = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', TSX_LOADER, CLI_ENTRY, ...args],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          HYBRIDCLAW_DATA_DIR: '',
          HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
          PLUGIN_CLI_DISPATCH_TEST_UNSET_SECRET: '',
        },
        timeout: 60_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

describe('plugin CLI dispatch with other installed plugins', () => {
  let home = '';
  let markerDir = '';

  beforeEach(() => {
    home = makeTempDir();
    markerDir = path.join(home, 'markers');
    fs.mkdirSync(markerDir, { recursive: true });
    const pluginsDir = path.join(home, '.hybridclaw', 'plugins');
    for (const plugin of FIXTURE_PLUGINS) {
      writeFixturePlugin(pluginsDir, markerDir, plugin);
    }
  });

  function importedPlugins(): string[] {
    const imported = fs.readdirSync(markerDir).sort();
    for (const marker of imported) fs.rmSync(path.join(markerDir, marker));
    return imported;
  }

  test('a plugin command writes only its own output to stdout and loads only its plugin', async () => {
    const result = await cli(home, ['echo-args', 'status', '--alias', 'x']);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toBe('["status","--alias","x"]\n');
    expect(importedPlugins()).toEqual(['echo']);
  }, 120_000);

  test('an unknown command imports no plugin and prints usage', async () => {
    const result = await cli(home, ['stauts']);
    expect(result.code).toBe(1);
    expect(result.stdout.startsWith('Usage: hybridclaw <command>')).toBe(true);
    expect(importedPlugins()).toEqual([]);
  }, 120_000);

  test('main usage lists installed plugin commands from their manifests', async () => {
    const result = await cli(home, ['help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/echo-args\s+Print the arguments as JSON/);
    expect(result.stdout).toMatch(/broken-cmd\s+Never loads/);
    expect(importedPlugins()).toEqual([]);
  }, 120_000);

  test('help <plugin command> runs the command with --help', async () => {
    const result = await cli(home, ['help', 'echo-args']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('["--help"]\n');
  }, 120_000);

  test('a declared command whose plugin fails to load reports why on stderr', async () => {
    const result = await cli(home, ['broken-cmd']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('"throws"');
    expect(result.stderr).toContain('boom');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(importedPlugins()).toEqual(['throws']);
  }, 120_000);

  test('a name two plugins declare fails instead of picking one', async () => {
    const result = await cli(home, ['dup-cmd']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/dup-a.*dup-b/);
    expect(importedPlugins()).toEqual([]);
  }, 120_000);
});

// The bundled `distill` plugin declares `coworker`. Upgraded installs that
// have not installed it yet get the install command, not the generic usage.
describe('plugin CLI commands of bundled plugins that are not installed', () => {
  test.each([
    [['coworker', 'status', '--alias', 'maya']],
    [['help', 'coworker']],
  ])('%j names the plugin and its install command on stderr', async (args) => {
    const result = await cli(makeTempDir(), args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('"distill"');
    expect(result.stderr).toContain('hybridclaw plugin install distill');
  }, 120_000);
});

// A disabled plugin's `enabled: false` entry is not "not installed": the
// hint must be the enable command, whether the plugin is bundled or a home
// install, no plugin code may run, and following the hint must work.
describe('plugin CLI commands of disabled plugins', () => {
  test.each([
    ['bundled', 'distill', ['coworker', '--help'], /^Usage: hybridclaw coworker /m],
    ['home-installed', 'echo', ['echo-args', 'x'], /^\["x"\]$/m],
  ])('a %s plugin names the enable command, and enabling it runs the command', async (_kind, pluginId, args, ranPattern) => {
    const home = makeTempDir();
    const markerDir = path.join(home, 'markers');
    fs.mkdirSync(markerDir, { recursive: true });
    const echo = FIXTURE_PLUGINS.find((plugin) => plugin.id === 'echo');
    if (!echo) throw new Error('missing echo fixture');
    writeFixturePlugin(
      path.join(home, '.hybridclaw', 'plugins'),
      markerDir,
      echo,
    );
    fs.writeFileSync(
      path.join(home, '.hybridclaw', 'config.json'),
      JSON.stringify({ plugins: { list: [{ id: pluginId, enabled: false }] } }),
    );

    const disabled = await cli(home, args);
    expect(disabled.code).toBe(1);
    expect(disabled.stderr).toContain(`"${pluginId}"`);
    expect(disabled.stderr).toContain(`hybridclaw plugin enable ${pluginId}`);
    expect(disabled.stderr).not.toContain('plugin install');
    expect(fs.readdirSync(markerDir)).toEqual([]);

    expect(await cli(home, ['plugin', 'enable', pluginId])).toMatchObject({
      code: 0,
    });
    const enabled = await cli(home, args);
    expect(enabled.code).toBe(0);
    expect(enabled.stdout).toMatch(ranPattern);
  }, 180_000);
});

// Project plugins (`<cwd>/.hybridclaw/plugins`) never provide CLI commands:
// running `hybridclaw <name>` inside an untrusted checkout must not execute
// that checkout's plugin code, and must not replace an installed plugin.
describe('plugin CLI dispatch inside a checkout with project plugins', () => {
  let home = '';
  let project = '';
  let markerDir = '';

  beforeEach(() => {
    home = makeTempDir();
    project = makeTempDir();
    markerDir = path.join(home, 'markers');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.mkdirSync(path.join(home, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.hybridclaw', 'config.json'),
      JSON.stringify({ plugins: { list: [{ id: 'distill', enabled: true }] } }),
    );
    const projectPlugins = path.join(project, '.hybridclaw', 'plugins');
    for (const [id, command] of [
      ['distill', 'coworker'],
      ['shadow', 'shadow-cmd'],
    ]) {
      writeFixturePlugin(projectPlugins, markerDir, {
        id,
        manifest: [
          'cliCommands:',
          `  - name: ${command}`,
          '    description: Project plugin command',
        ].join('\n'),
        register: `api.registerCliCommand({ name: '${command}', run: () => { process.stdout.write('PROJECT PLUGIN RAN\\n'); } });`,
      });
    }
  });

  test('an installed bundled plugin runs, not the project plugin with its id', async () => {
    const result = await cli(home, ['coworker', '--help'], project);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: hybridclaw coworker /m);
    expect(result.stdout).not.toContain('PROJECT PLUGIN RAN');
    expect(fs.readdirSync(markerDir)).toEqual([]);
  }, 120_000);

  test('a command only a project plugin declares runs no plugin code', async () => {
    const result = await cli(home, ['shadow-cmd'], project);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('PROJECT PLUGIN RAN');
    expect(result.stdout).toMatch(/^Usage: hybridclaw <command>/m);
    expect(fs.readdirSync(markerDir)).toEqual([]);
  }, 120_000);
});
