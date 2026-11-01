import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runFileWrite } from '../container/src/tools/file-write.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir();
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

describe('local writes', () => {
  let root: string;
  let file: string;
  let write: (args: Record<string, unknown>) => string;
  beforeEach(() => {
    root = makeTempDir('guarded-write-');
    file = path.join(root, 'report.txt');
    write = (args) =>
      runFileWrite(args, (userPath) => path.join(root, userPath));
  });

  test('creates nested files and rejects accidental replacement', () => {
    expect(write({ path: 'nested/note.txt', contents: 'café\n' })).toContain(
      '6 bytes',
    );
    expect(fs.readFileSync(path.join(root, 'nested/note.txt'), 'utf8')).toBe(
      'café\n',
    );
    fs.writeFileSync(file, 'keep me');
    for (const overwrite of [undefined, false]) {
      expect(() =>
        write({ path: 'report.txt', contents: 'replacement', overwrite }),
      ).toThrow(/already exists/);
      expect(fs.readFileSync(file, 'utf8')).toBe('keep me');
    }
  });

  test.each([
    { overwrite: 'true' },
    { overwrite: true },
    { overwrite: true, expected_content: null },
    { expected_content: 'original' },
  ])('rejects invalid replacement arguments %j', (fields) => {
    fs.writeFileSync(file, 'original');
    expect(() =>
      write({ path: 'report.txt', contents: 'replacement', ...fields }),
    ).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
  });

  test.each(['', 'original\n', 'café\r\n\0data'])(
    'replaces intentionally with exact expected content %j',
    (original) => {
      fs.writeFileSync(file, original, { mode: 0o640 });
      expect(
        write({
          path: 'report.txt',
          contents: 'replacement',
          overwrite: true,
          expected_content: original,
        }),
      ).toContain('Wrote');
      expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
      expect(fs.statSync(file).mode & 0o777).toBe(0o640);
      expect(fs.readdirSync(root)).toEqual(['report.txt']);
    },
  );

  test('rejects a stale read and permits a deliberate replacement after rereading', () => {
    fs.writeFileSync(file, 'first');
    const stale = fs.readFileSync(file, 'utf8');
    write({
      path: 'report.txt',
      contents: 'second',
      overwrite: true,
      expected_content: stale,
    });
    expect(() =>
      write({
        path: 'report.txt',
        contents: 'third',
        overwrite: true,
        expected_content: stale,
      }),
    ).toThrow(/Stale write/);
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
    write({
      path: 'report.txt',
      contents: 'third',
      overwrite: true,
      expected_content: fs.readFileSync(file, 'utf8'),
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('third');
    expect(fs.readdirSync(root)).toEqual(['report.txt']);
  });

  test.each(['original', 'original\r\n'])(
    'rejects whitespace-only stale content %j',
    (expected_content) => {
      fs.writeFileSync(file, 'original\n');
      expect(() =>
        write({
          path: 'report.txt',
          contents: 'replacement',
          overwrite: true,
          expected_content,
        }),
      ).toThrow(/Stale write/);
      expect(fs.readFileSync(file, 'utf8')).toBe('original\n');
      expect(fs.readdirSync(root)).toEqual(['report.txt']);
    },
  );

  test('does not recreate a deleted replacement target or treat missing as empty', () => {
    expect(() =>
      write({
        path: 'report.txt',
        contents: 'replacement',
        overwrite: true,
        expected_content: '',
      }),
    ).toThrow(/existing regular file/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test('fails closed on a competing or abandoned lock', () => {
    fs.writeFileSync(file, 'original');
    fs.mkdirSync(`${file}.lock`);
    expect(() =>
      write({
        path: 'report.txt',
        contents: 'replacement',
        overwrite: true,
        expected_content: 'original',
      }),
    ).toThrow(/locked/);
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
  });

  test('never follows a symlink replacement target', () => {
    const real = path.join(root, 'real.txt');
    fs.writeFileSync(real, 'original');
    fs.symlinkSync(real, file);
    expect(() =>
      write({
        path: 'report.txt',
        contents: 'replacement',
        overwrite: true,
        expected_content: 'original',
      }),
    ).toThrow(/existing regular file/);
    expect(fs.readFileSync(real, 'utf8')).toBe('original');
  });
});

test('tool dispatch advertises the contract and returns failures as errors across workers', async () => {
  const root = makeTempDir('write-dispatch-');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', '');
  const tools = await import('../container/src/tools.js');
  const call = { path: 'report.txt', contents: 'original' };
  expect(
    await tools.executeToolWithMetadata('write', JSON.stringify(call)),
  ).toMatchObject({ isError: false });
  vi.resetModules();
  const restarted = await import('../container/src/tools.js');
  expect(
    await restarted.executeToolWithMetadata('write', JSON.stringify(call)),
  ).toMatchObject({ isError: true });
  expect(
    await restarted.executeToolWithMetadata(
      'write',
      JSON.stringify({
        ...call,
        contents: 'replacement',
        overwrite: true,
        expected_content: 'stale',
      }),
    ),
  ).toMatchObject({ isError: true });
  expect(
    await restarted.executeToolWithMetadata(
      'write',
      JSON.stringify({
        ...call,
        contents: 'replacement',
        overwrite: true,
        expected_content: 'original',
      }),
    ),
  ).toMatchObject({ isError: false });
  expect(fs.readFileSync(path.join(root, call.path), 'utf8')).toBe(
    'replacement',
  );
  const definition = restarted.TOOL_DEFINITIONS.find(
    (tool) => tool.function.name === 'write',
  );
  expect(definition?.function.parameters.properties).toHaveProperty(
    'overwrite',
  );
  expect(definition?.function.parameters.properties).toHaveProperty(
    'expected_content',
  );
  expect(
    await restarted.executeToolWithMetadata(
      'write',
      JSON.stringify({ path: '../escape.txt', contents: 'bad' }),
    ),
  ).toMatchObject({ isError: true });
});
