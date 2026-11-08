import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('sandbox-edit-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let container = '';
afterEach(() => {
  if (container)
    spawnSync('docker', ['rm', '-f', container], { timeout: 15_000 });
  container = '';
});

test.skipIf(process.env.HYBRIDCLAW_TEST_DOCKER !== '1')(
  'task-sandbox edits respect locks and preserve exact bytes, modes and symlink targets',
  async () => {
    const root = temporary();
    container = `hc-file-edit-${randomUUID()}`;
    const started = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--network=none',
        '--read-only',
        '--cpus=1',
        '--memory=256m',
        '--memory-swap=256m',
        '--name',
        container,
        '-v',
        `${root}:/workspace`,
        '--entrypoint',
        'sleep',
        process.env.HYBRIDCLAW_TEST_DOCKER_IMAGE || 'node:22-slim',
        'infinity',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(started.status, started.stderr).toBe(0);
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', container);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
    vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const edit = (target: string, old: string, replacement: string) =>
      executeToolWithMetadata(
        'edit',
        JSON.stringify({ path: target, old, new: replacement }),
      );
    const file = path.join(root, 'report.txt');
    const original = 'Status: draft\r\nReviewer: café\r\n';
    fs.writeFileSync(file, original, { mode: 0o640 });
    fs.mkdirSync(`${file}.lock`);
    expect(await edit('report.txt', 'draft', 'final')).toMatchObject({
      isError: true,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    fs.rmdirSync(`${file}.lock`);
    expect(await edit('report.txt', 'draft', 'final')).toMatchObject({
      isError: false,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      'Status: final\r\nReviewer: café\r\n',
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    const actual = path.join(root, 'actual.txt');
    fs.renameSync(file, actual);
    fs.symlinkSync('actual.txt', file);
    expect(await edit('report.txt', 'final', 'reviewed')).toMatchObject({
      isError: true,
    });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(actual, 'utf8')).toBe(
      'Status: final\r\nReviewer: café\r\n',
    );
    expect(await edit('actual.txt', 'final', 'reviewed')).toMatchObject({
      isError: false,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      'Status: reviewed\r\nReviewer: café\r\n',
    );
    expect(fs.readdirSync(root).sort()).toEqual(['actual.txt', 'report.txt']);
  },
  30_000,
);
