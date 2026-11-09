import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { lockMemoryFile } from '@hybridclaw/shared/memory-file';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeDir = useTempDir('memory-lock-owner-');
useCleanMocks({ restoreAllMocks: true });
const moduleUrl = new URL('../packages/shared/src/memory-file.js', import.meta.url)
  .href;
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
});

async function holdLock(file: string) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { lockMemoryFile } from ${JSON.stringify(moduleUrl)};
    const release = lockMemoryFile(process.argv[1]);
    process.on('message', () => { release(); process.disconnect(); });
    process.send('ready');
  `,
      file,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
    child.once('exit', () =>
      reject(new Error(stderr || 'Writer exited before acquiring lock')),
    );
  });
  return child;
}

function ageLock(file: string) {
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
}

async function killWriter(child: ChildProcess) {
  const finished = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await finished;
}

test('does not reclaim an old lock from a live independent writer', async () => {
  const file = path.join(makeDir(), 'note.md');
  const child = await holdLock(file);
  ageLock(file);
  expect(() => lockMemoryFile(file)).toThrow('Memory file is locked');
  const finished = new Promise((resolve) => child.once('exit', resolve));
  child.send('release');
  await finished;
  lockMemoryFile(file)();
});

test('recovers a confirmed dead writer without waiting for a time threshold', async () => {
  const file = path.join(makeDir(), 'note.md');
  const child = await holdLock(file);
  await killWriter(child);
  lockMemoryFile(file)();
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

test('does not infer death from the age of an unidentified lock', () => {
  const file = path.join(makeDir(), 'note.md');
  fs.mkdirSync(`${file}.lock`);
  ageLock(file);
  expect(() => lockMemoryFile(file)).toThrow('Memory file is locked');
  expect(fs.existsSync(`${file}.lock`)).toBe(true);
});

test.each([
  [
    'foreign namespace',
    (owner: Record<string, unknown>) =>
      JSON.stringify({ ...owner, namespace: 'another-boot-or-pid-namespace' }),
  ],
  ['malformed JSON', () => '{invalid'],
  ['null', () => 'null'],
  [
    'invalid PID',
    (owner: Record<string, unknown>) => JSON.stringify({ ...owner, pid: 0 }),
  ],
  [
    'string PID',
    (owner: Record<string, unknown>) => JSON.stringify({ ...owner, pid: '1' }),
  ],
  ['oversized record', () => ' '.repeat(1_025)],
] as const)('leaves a dead lock with %s intact', async (_label, corrupt) => {
  const file = path.join(makeDir(), 'note.md');
  const child = await holdLock(file);
  await killWriter(child);
  const lockPath = `${file}.lock`;
  const [entry] = fs.readdirSync(lockPath);
  const ownerPath = path.join(lockPath, entry);
  const content = corrupt(JSON.parse(fs.readFileSync(ownerPath, 'utf8')));
  fs.writeFileSync(ownerPath, content);
  ageLock(file);
  expect(() => lockMemoryFile(file)).toThrow('Memory file is locked');
  expect(fs.readFileSync(ownerPath, 'utf8')).toBe(content);
});

test('permission failure while probing a PID does not establish owner death', async () => {
  const file = path.join(makeDir(), 'note.md');
  const child = await holdLock(file);
  await killWriter(child);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
  });
  expect(() => lockMemoryFile(file)).toThrow('Memory file is locked');
  expect(fs.existsSync(`${file}.lock`)).toBe(true);
});

test('failed ownership publication releases an otherwise empty acquired lock', () => {
  const file = path.join(makeDir(), 'note.md');
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw new Error('publication failed');
  });
  expect(() => lockMemoryFile(file)).toThrow('publication failed');
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
  lockMemoryFile(file)();
});

test('an old release cannot delete a new writer lock', () => {
  const file = path.join(makeDir(), 'note.md');
  const release = lockMemoryFile(file);
  fs.rmSync(`${file}.lock`, { recursive: true });
  const releaseNew = lockMemoryFile(file);
  expect(release).toThrow();
  expect(() => lockMemoryFile(file)).toThrow('Memory file is locked');
  releaseNew();
});

test('a losing reaper cannot remove a lock acquired after its owner check', async () => {
  const file = path.join(makeDir(), 'note.md');
  await killWriter(await holdLock(file));
  const lockPath = `${file}.lock`;
  const ownerPath = path.join(lockPath, fs.readdirSync(lockPath)[0]);
  const unlink = fs.unlinkSync;
  let releaseNew: (() => void) | undefined;
  vi.spyOn(fs, 'unlinkSync').mockImplementationOnce((target) => {
    expect(target).toBe(ownerPath);
    unlink(ownerPath);
    fs.rmdirSync(lockPath);
    releaseNew = lockMemoryFile(file);
    unlink(ownerPath);
  });
  try {
    expect(() => lockMemoryFile(file)).toThrow('Memory file is locked');
    expect(fs.readdirSync(lockPath)).toHaveLength(1);
  } finally {
    releaseNew?.();
  }
});

test.each(['owner symlink', 'directory symlink', 'extra entry'])(
  'leaves a lock with %s intact',
  async (kind) => {
    const root = makeDir();
    const file = path.join(root, 'note.md');
    await killWriter(await holdLock(file));
    const lockPath = `${file}.lock`;
    const ownerPath = path.join(lockPath, fs.readdirSync(lockPath)[0]);
    if (kind === 'owner symlink') {
      const outside = path.join(root, 'outside.json');
      fs.renameSync(ownerPath, outside);
      fs.symlinkSync(outside, ownerPath);
    } else if (kind === 'directory symlink') {
      const outside = path.join(root, 'outside');
      fs.renameSync(lockPath, outside);
      fs.symlinkSync(outside, lockPath, 'dir');
    } else {
      fs.writeFileSync(path.join(lockPath, 'unexpected'), 'keep');
    }
    const before = fs.readdirSync(lockPath);
    expect(() => lockMemoryFile(file)).toThrow('Memory file is locked');
    expect(fs.readdirSync(lockPath)).toEqual(before);
  },
);

test('competing dead-owner reapers do not lose updates or remove new locks', async () => {
  const file = path.join(makeDir(), 'note.md');
  fs.writeFileSync(file, '');
  await killWriter(await holdLock(file));
  await Promise.all(
    Array.from(
      { length: 8 },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `
      import fs from 'node:fs';
      import { waitForMemoryFileLock, writeMemoryFileAtomic } from ${JSON.stringify(moduleUrl)};
      const file = process.argv[1];
      const release = await waitForMemoryFileLock(file);
      try {
        const before = fs.readFileSync(file, 'utf8');
        await new Promise(resolve => setTimeout(resolve, 20));
        writeMemoryFileAtomic(file, before + process.argv[2] + '\\n');
      } finally { release(); }
    `,
              file,
              String(index),
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          children.push(child);
          let stderr = '';
          child.stderr!.on('data', (chunk) => {
            stderr += chunk;
          });
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(stderr)),
          );
        }),
    ),
  );
  expect(fs.readFileSync(file, 'utf8').trim().split('\n').sort()).toEqual([
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
  ]);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});
