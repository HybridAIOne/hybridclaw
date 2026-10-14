import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  writeFileAtomic,
  writeFileAtomicAsync,
  writeFileAtomicExclusive,
} from '../container/shared/atomic-write.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('atomic-write-');
useCleanMocks({ restoreAllMocks: true });

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe('writeFileAtomic', () => {
  it('creates missing parents and replaces an existing file', () => {
    const target = path.join(makeTempDir(), 'a', 'b', 'state.json');
    writeFileAtomic(target, 'one', { dirMode: 0o700 });
    writeFileAtomic(target, 'two');
    expect(fs.readFileSync(target, 'utf8')).toBe('two');
    expect(mode(path.dirname(target))).toBe(0o700);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['state.json']);
  });

  it('applies the mode exactly, regardless of umask', () => {
    const target = path.join(makeTempDir(), 'secret.json');
    const previous = process.umask(0o077);
    try {
      writeFileAtomic(target, '{}', { mode: 0o644 });
    } finally {
      process.umask(previous);
    }
    expect(mode(target)).toBe(0o644);
    writeFileAtomic(target, '{}', { mode: 0o600 });
    expect(mode(target)).toBe(0o600);
  });

  it('gives an interleaved writer its own temp file', () => {
    const target = path.join(makeTempDir(), 'store.json');
    const rename = fs.renameSync.bind(fs);
    const sources: string[] = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      sources.push(String(source));
      // A second writer runs between the first writer's write and rename.
      if (sources.length === 1) writeFileAtomic(target, 'second');
      rename(source, destination);
    });

    writeFileAtomic(target, 'first');

    expect(new Set(sources).size).toBe(2);
    expect(fs.readFileSync(target, 'utf8')).toBe('first');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['store.json']);
  });

  it('removes the temp file and keeps the old content when rename fails', () => {
    const target = path.join(makeTempDir(), 'store.json');
    writeFileAtomic(target, 'old');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => writeFileAtomic(target, 'new')).toThrow('disk full');
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['store.json']);
  });
});

describe('writeFileAtomicAsync', () => {
  it('leaves exactly one complete file after concurrent writers', async () => {
    const target = path.join(makeTempDir(), 'nested', 'cv.json');
    const contents = Array.from({ length: 20 }, (_, i) => `writer-${i}`);
    await Promise.all(
      contents.map((content) =>
        writeFileAtomicAsync(target, content, { mode: 0o600 }),
      ),
    );
    expect(contents).toContain(fs.readFileSync(target, 'utf8'));
    expect(mode(target)).toBe(0o600);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['cv.json']);
  });

  it('removes the temp file when rename fails', async () => {
    const target = path.join(makeTempDir(), 'cv.json');
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('disk full'));
    await expect(writeFileAtomicAsync(target, 'x')).rejects.toThrow(
      'disk full',
    );
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
  });
});

describe('writeFileAtomicExclusive', () => {
  it('creates the file once and refuses to replace it', () => {
    const target = path.join(makeTempDir(), 'keys', 'keypair.json');
    writeFileAtomicExclusive(target, 'first', { mode: 0o600, dirMode: 0o700 });
    expect(() => writeFileAtomicExclusive(target, 'second')).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('first');
    expect(mode(target)).toBe(0o600);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['keypair.json']);
  });
});
