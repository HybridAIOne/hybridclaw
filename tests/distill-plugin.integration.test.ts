import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { useTempDir } from './test-utils.js';

// The real CLI (`node --import tsx src/cli.ts`, as in dev) with a real plugin
// install: `coworker` names its plugin until the bundled distill plugin is
// enabled in place, and then reaches the plugin through `registerCliCommand`
// and the plugin SDK.
const makeTempDir = useTempDir('hybridclaw-distill-cli-');
const execFileAsync = promisify(execFile);

async function cli(
  home: string,
  args: string[],
): Promise<{ code: number; out: string }> {
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
        },
        timeout: 60_000,
      },
    );
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      out: `${failed.stdout ?? ''}${failed.stderr ?? ''}`,
    };
  }
}

test('coworker points at the distill plugin until it is installed, then runs from the bundled copy', async () => {
  const home = makeTempDir();
  const source = path.join(home, 'memo.md');
  fs.writeFileSync(source, '# Memo\n\nBoring options win until measured.\n');

  const before = await cli(home, ['coworker', 'status', '--alias', 'nova']);
  expect(before.code).toBe(1);
  expect(before.out).toContain('hybridclaw plugin install distill');

  const install = await cli(home, ['plugin', 'install', 'distill']);
  expect(install.code).toBe(0);
  expect(
    fs.existsSync(path.join(home, '.hybridclaw', 'plugins', 'distill')),
  ).toBe(false);
  const config = JSON.parse(
    fs.readFileSync(path.join(home, '.hybridclaw', 'config.json'), 'utf-8'),
  ) as { plugins: { list: Array<{ id: string; enabled: boolean }> } };
  expect(config.plugins.list).toContainEqual(
    expect.objectContaining({ id: 'distill', enabled: true }),
  );
  const list = await cli(home, ['plugin', 'list']);
  expect(list.out).toMatch(/^distill v\S+ \[bundled\]$/m);

  const blocked = await cli(home, [
    'coworker',
    'distill',
    '--alias',
    'nova',
    '--name',
    'Nova',
    '--source',
    source,
  ]);
  expect(blocked.code).toBe(1);
  expect(blocked.out).toContain('blocked: no consent artefact recorded');

  const consent = await cli(home, [
    'coworker',
    'consent',
    'record',
    '--alias',
    'nova',
    '--granted-by',
    'Nova',
    '--method',
    'written',
    '--statement',
    'I consent.',
  ]);
  expect(consent.code).toBe(0);

  const run = await cli(home, [
    'coworker',
    'distill',
    '--alias',
    'nova',
    '--source',
    source,
    '--holdout',
    '0',
  ]);
  expect(run.code).toBe(0);
  expect(run.out).toContain('awaiting-extraction');

  const status = await cli(home, ['coworker', 'status', '--alias', 'nova']);
  expect(status.code).toBe(0);
  expect(status.out).toContain('Coworker: Nova');
  expect(status.out).toContain('Corpus: 1 documents');

  const audit = await cli(home, ['audit', 'verify', 'distill:nova']);
  expect(audit.code).toBe(0);
  expect(audit.out).toMatch(/\d+ records verified for distill:nova/);
}, 240_000);
