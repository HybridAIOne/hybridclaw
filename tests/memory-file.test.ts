import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { lockMemoryFile, writeMemoryFileAtomic } from '../container/shared/memory-file.js';

const directories: string[] = [];
function temporaryFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-transaction-'));
  directories.push(directory);
  return path.join(directory, 'note.md');
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('serializes read-modify-write across independent processes', async () => {
  const file = temporaryFile();
  const moduleUrl = new URL('../container/shared/memory-file.js', import.meta.url).href;
  await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { waitForMemoryFileLock, writeMemoryFileAtomic } from ${JSON.stringify(moduleUrl)};
      const file = process.argv[1];
      const release = await waitForMemoryFileLock(file);
      try {
        const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        await new Promise(resolve => setTimeout(resolve, 10));
        writeMemoryFileAtomic(file, before + process.argv[2] + '\\n');
      } finally { release(); }
    `, file, String(index)], { stdio: 'pipe' });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)));
  })));
  expect(fs.readFileSync(file, 'utf8').trim().split('\n').sort()).toEqual(['0','1','2','3','4','5','6','7']);
});

test('does not steal a held lock and permits acquisition after release', () => {
  const file = temporaryFile();
  const release = lockMemoryFile(file);
  expect(() => lockMemoryFile(file)).toThrow('Memory file is locked');
  release();
  lockMemoryFile(file)();
});

test('failed rename preserves the original and removes the temporary file', () => {
  const file = temporaryFile();
  fs.writeFileSync(file, 'original');
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('rename failed'); });
  expect(() => writeMemoryFileAtomic(file, 'replacement')).toThrow('rename failed');
  expect(fs.readFileSync(file, 'utf8')).toBe('original');
  expect(fs.readdirSync(path.dirname(file))).toEqual(['note.md']);
});
