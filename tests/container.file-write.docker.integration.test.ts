import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir();
let container = '';
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
afterEach(() => {
  if (container) spawnSync('docker', ['rm', '-f', container]);
  container = '';
});

describe.skipIf(process.env.HYBRIDCLAW_TEST_DOCKER !== '1')(
  'guarded task-sandbox writes',
  () => {
    test('checks and publishes inside Docker, preserving newer files and exact bytes', async () => {
      const root = makeTempDir('sandbox-write-');
      container = `hc-file-write-${randomUUID()}`;
      const started = spawnSync(
        'docker',
        [
          'run',
          '-d',
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
      vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
      const { executeToolWithMetadata } = await import(
        '../container/src/tools.js'
      );
      const write = (args: Record<string, unknown>) =>
        executeToolWithMetadata('write', JSON.stringify(args));
      const file = path.join(root, 'report.txt');
      const original = 'café\r\n\0literal $(touch marker) \' "\n';
      expect(
        await write({ path: 'report.txt', contents: original }),
      ).toMatchObject({ isError: false });
      expect(
        await write({ path: 'report.txt', contents: 'accidental' }),
      ).toMatchObject({ isError: true });
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      fs.chmodSync(file, 0o640);
      expect(
        await write({
          path: 'report.txt',
          contents: 'intentional',
          overwrite: true,
          expected_content: original,
        }),
      ).toMatchObject({ isError: false });
      expect(fs.statSync(file).mode & 0o777).toBe(0o640);
      expect(
        await write({
          path: 'report.txt',
          contents: 'stale',
          overwrite: true,
          expected_content: original,
        }),
      ).toMatchObject({
        isError: true,
        output: expect.stringContaining('Stale write'),
      });
      expect(fs.readFileSync(file, 'utf8')).toBe('intentional');
      expect(
        await write({
          path: 'report.txt',
          contents: '',
          overwrite: true,
          expected_content: 'intentional',
        }),
      ).toMatchObject({ isError: false });
      expect(
        await write({
          path: 'report.txt',
          contents: 'from empty',
          overwrite: true,
          expected_content: '',
        }),
      ).toMatchObject({ isError: false });
      expect(fs.readFileSync(file, 'utf8')).toBe('from empty');
      fs.unlinkSync(file);
      expect(
        await write({
          path: 'report.txt',
          contents: 'resurrected',
          overwrite: true,
          expected_content: '',
        }),
      ).toMatchObject({ isError: true });
      fs.writeFileSync(file, 'keep');
      fs.mkdirSync(`${file}.lock`);
      expect(
        await write({
          path: 'report.txt',
          contents: 'locked',
          overwrite: true,
          expected_content: 'keep',
        }),
      ).toMatchObject({ isError: true });
      expect(fs.existsSync(`${file}.lock`)).toBe(true);
      fs.rmdirSync(`${file}.lock`);
      expect(fs.readFileSync(file, 'utf8')).toBe('keep');
      expect(fs.readdirSync(root)).toEqual(['report.txt']);
    }, 40_000);
  },
);
