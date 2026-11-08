import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('edit-transaction-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let root: string;
let file: string;
const original = 'Status: draft\nReviewer: pending\n';
beforeEach(() => {
  root = temporary();
  file = path.join(root, 'report.txt');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', root);
  fs.writeFileSync(file, original, { mode: 0o640 });
});

async function editor() {
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  return () =>
    executeToolWithMetadata(
      'edit',
      JSON.stringify({
        path: 'report.txt',
        old: 'Status: draft',
        new: 'Status: final',
      }),
    );
}

test('edit respects another writer lock and remains usable after release', async () => {
  const edit = await editor();
  fs.mkdirSync(`${file}.lock`);
  expect(await edit()).toMatchObject({ isError: true });
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(fs.existsSync(`${file}.lock`)).toBe(true);
  fs.rmdirSync(`${file}.lock`);
  expect(await edit()).toMatchObject({ isError: false });
  expect(fs.readFileSync(file, 'utf8')).toBe(
    'Status: final\nReviewer: pending\n',
  );
  expect(fs.statSync(file).mode & 0o777).toBe(0o640);
});

test('edit rejects a competing update after its read, then can preserve it on retry', async () => {
  const edit = await editor();
  const newer = 'Status: draft\nReviewer: approved\n';
  const read = fs.readFileSync;
  let intervened = false;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
    const content = read(...args);
    if (args[0] === file && !intervened) {
      intervened = true;
      fs.writeFileSync(file, newer);
    }
    return content;
  });
  const result = await edit();
  spy.mockRestore();
  expect(intervened).toBe(true);
  expect(result).toMatchObject({ isError: true });
  expect(fs.readFileSync(file, 'utf8')).toBe(newer);
  expect(await edit()).toMatchObject({ isError: false });
  expect(fs.readFileSync(file, 'utf8')).toBe(
    'Status: final\nReviewer: approved\n',
  );
});

test('failed atomic publication leaves the original and releases the edit lock', async () => {
  const edit = await editor();
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('Synthetic publication failure'), {
      code: 'EIO',
    });
  });
  const result = await edit();
  rename.mockRestore();
  expect(result).toMatchObject({ isError: true });
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(fs.readdirSync(root)).toEqual(['report.txt']);
  expect(await edit()).toMatchObject({ isError: false });
});

test('edit protects symlink targets while a direct allowed-path edit stays available', async () => {
  const target = path.join(root, 'actual.txt');
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  const edit = await editor();
  expect(await edit()).toMatchObject({ isError: true });
  expect(fs.readFileSync(target, 'utf8')).toBe(original);
  expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  expect(
    await executeToolWithMetadata(
      'edit',
      JSON.stringify({
        path: 'actual.txt',
        old: 'Status: draft',
        new: 'Status: final',
      }),
    ),
  ).toMatchObject({ isError: false });
  expect(fs.readFileSync(file, 'utf8')).toBe(
    'Status: final\nReviewer: pending\n',
  );
});
