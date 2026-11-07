import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { ipcOutputFileName } from '../container/shared/ipc-output-files.js';
import { mockIpcWatcher } from './helpers/ipc-watcher.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-output-file-');
useCleanMocks({ restoreAllMocks: true, resetModules: true, unstubAllEnvs: true });
const output = { status: 'success', result: 'ok', toolsUsed: [] };
let ipc: typeof import('../src/infra/ipc.js');
let outputPath: string;
let dir: string;

beforeEach(async () => {
  dir = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dir);
  mockIpcWatcher();
  ipc = await import('../src/infra/ipc.js');
  ipc.ensureSessionDirs('session-a');
  const { DATA_DIR } = await import('../src/config/config.js');
  outputPath = path.join(DATA_DIR, 'sessions', 'session-a', 'ipc', ipcOutputFileName('request-a'));
});

const read = () => ipc.readOutput('session-a', 'request-a', 100);

test('consumes an ordinary reply', async () => {
  fs.writeFileSync(outputPath, JSON.stringify(output));
  await expect(read()).resolves.toEqual(output);
  expect(fs.existsSync(outputPath)).toBe(false);
});

test.each(['file', 'dangling', 'device'])(
  'rejects a symlink to a %s without reading its target',
  async (kind) => {
    const target = kind === 'device' ? '/dev/zero' : path.join(dir, 'outside.json');
    if (kind === 'file') fs.writeFileSync(target, JSON.stringify(output));
    fs.symlinkSync(target, outputPath);
    const readSpy = vi.spyOn(fs, 'readSync');
    await expect(read()).resolves.toMatchObject({ status: 'error', error: expect.stringContaining('Invalid agent output file') });
    expect(readSpy).not.toHaveBeenCalled();
    if (kind === 'file') expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify(output));
  },
);

test.each(['directory', 'fifo', 'oversized'])(
  'rejects a %s before reading',
  async (kind) => {
    if (kind === 'directory') fs.mkdirSync(outputPath);
    if (kind === 'fifo') execFileSync('mkfifo', [outputPath]);
    if (kind === 'oversized') {
      const { CONTAINER_MAX_OUTPUT_SIZE } = await import('../src/config/config.js');
      fs.writeFileSync(outputPath, '');
      fs.truncateSync(outputPath, CONTAINER_MAX_OUTPUT_SIZE + 1);
    }
    const readSpy = vi.spyOn(fs, 'readSync');
    await expect(read()).resolves.toMatchObject({ status: 'error', error: expect.stringContaining('Invalid agent output file') });
    expect(readSpy).not.toHaveBeenCalled();
  },
);

test('a growing file cannot bypass the read bound', async () => {
  const raw = JSON.stringify(output);
  fs.writeFileSync(outputPath, raw);
  const fstat = fs.fstatSync;
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce(((fd: number) => {
    const stat = fstat(fd);
    fs.appendFileSync(outputPath, ' '.repeat(4096));
    return stat;
  }) as typeof fs.fstatSync);
  const readSpy = vi.spyOn(fs, 'readSync');
  await expect(read()).resolves.toMatchObject({ status: 'error' });
  expect(readSpy.mock.results.reduce((sum, result) => sum + Number(result.value), 0)).toBe(Buffer.byteLength(raw) + 1);
});

test('a replaced pathname cannot substitute another reply', async () => {
  fs.writeFileSync(outputPath, JSON.stringify(output));
  const fstat = fs.fstatSync;
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce(((fd: number) => {
    const stat = fstat(fd);
    fs.renameSync(outputPath, path.join(dir, 'original.json'));
    fs.writeFileSync(outputPath, JSON.stringify({ ...output, result: 'substitute' }));
    return stat;
  }) as typeof fs.fstatSync);
  await expect(read()).resolves.toMatchObject({ status: 'error' });
});
