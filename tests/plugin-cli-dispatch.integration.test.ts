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

async function cli(
  home: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', ...args],
      {
        cwd: process.cwd(),
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
