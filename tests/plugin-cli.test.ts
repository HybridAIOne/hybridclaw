import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-plugin-cli-');

useCleanMocks({ resetModules: true, unstubAllEnvs: true });

function writeScript(dir: string, lines: string[]): string {
  const scriptPath = path.join(dir, 'cli.mjs');
  fs.writeFileSync(scriptPath, [...lines, ''].join('\n'), 'utf-8');
  return scriptPath;
}

async function loadPluginCli() {
  return await import('../src/plugins/plugin-cli.ts');
}

test('runBoundedCli caps each stream at the byte budget with a 32 KiB floor', async () => {
  const cwd = makeTempDir();
  const script = writeScript(cwd, [
    'process.stdout.write("A".repeat(80000));',
    'process.stderr.write("B".repeat(80000));',
  ]);
  const { runBoundedCli } = await loadPluginCli();

  const floored = await runBoundedCli({
    command: process.execPath,
    args: [script],
    maxChars: 500,
    label: 'Test',
  });
  expect(floored).toMatchObject({
    ok: true,
    stdoutTruncated: true,
    stderrTruncated: true,
  });
  expect(Buffer.byteLength(floored.stdout)).toBe(32_768);
  expect(Buffer.byteLength(floored.stderr)).toBe(32_768);

  const explicit = await runBoundedCli({
    command: process.execPath,
    args: [script],
    maxBytes: 40_000,
    maxChars: 500,
    label: 'Test',
  });
  expect(Buffer.byteLength(explicit.stdout)).toBe(40_000);
});

test('runBoundedCli passes only the allowlisted environment plus extras', async () => {
  const cwd = makeTempDir();
  const script = writeScript(cwd, [
    'process.stdout.write(JSON.stringify({',
    '  path: process.env.PATH || null,',
    '  secret: process.env.HYBRIDCLAW_PLUGIN_CLI_SECRET || null,',
    '  extra: process.env.PLUGIN_CLI_EXTRA || null,',
    '  cwd: process.cwd(),',
    '}));',
  ]);
  vi.stubEnv('HYBRIDCLAW_PLUGIN_CLI_SECRET', 'super-secret');
  const { runBoundedCli } = await loadPluginCli();

  const result = await runBoundedCli({
    command: process.execPath,
    args: [script],
    cwd,
    env: { PLUGIN_CLI_EXTRA: 'from-plugin' },
    label: 'Test',
  });

  expect(result.ok).toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    path: expect.any(String),
    secret: null,
    extra: 'from-plugin',
    cwd: fs.realpathSync(cwd),
  });
});

test.each([
  {
    name: 'stderr',
    lines: ['process.stderr.write("bad flag\\n");', 'process.exit(2);'],
    message: 'bad flag',
  },
  {
    name: 'stdout when stderr is empty',
    lines: ['process.stdout.write("no index\\n");', 'process.exit(2);'],
    message: 'no index',
  },
  {
    name: 'the exit code when both are empty',
    lines: ['process.exit(3);'],
    message: 'Test exited with code 3.',
  },
  {
    name: 'a notice when stderr was truncated',
    lines: [
      'process.stderr.write("x".repeat(40000), () => process.exit(1));',
    ],
    message: '[Test stderr truncated]',
  },
])('runBoundedCli reports a non-zero exit with $name', async ({
  lines,
  message,
}) => {
  const cwd = makeTempDir();
  const { runBoundedCli } = await loadPluginCli();

  const result = await runBoundedCli({
    command: process.execPath,
    args: [writeScript(cwd, lines)],
    label: 'Test',
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected the CLI run to fail');
  expect(result.error.message).toContain(message);
});

test('runBoundedCli reports a spawn failure without throwing', async () => {
  const { runBoundedCli } = await loadPluginCli();

  const result = await runBoundedCli({
    command: path.join(makeTempDir(), 'missing-cli'),
    args: [],
    label: 'Test',
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected the CLI run to fail');
  expect(result.error.message).toContain('ENOENT');
});

test('runBoundedCli sends SIGTERM, then SIGKILL, when a timed-out child does not exit', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn((signal: string) => {
      if (signal === 'SIGKILL') {
        setTimeout(() => child.emit('close', null, 'SIGKILL'), 0);
      }
      return true;
    }),
  });
  vi.useFakeTimers();
  vi.doMock('node:child_process', () => ({ spawn: vi.fn(() => child) }));

  try {
    const { runBoundedCli } = await loadPluginCli();
    const resultPromise = runBoundedCli({
      command: 'never-exits',
      args: [],
      timeoutMs: 100,
      label: 'Test',
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected the CLI run to time out');
    expect(result.error.message).toBe('Test timed out after 100ms.');
  } finally {
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
  }
});

test.each([
  { value: '~', expected: os.homedir() },
  { value: '~/notes', expected: path.join(os.homedir(), 'notes') },
  { value: '/srv/brain', expected: '/srv/brain' },
  { value: ' docs ', expected: path.resolve('/work', 'docs') },
  { value: '', expected: '' },
  { value: 42, expected: '' },
])('resolvePluginPath($value)', async ({ value, expected }) => {
  const { resolvePluginPath } = await loadPluginCli();
  expect(resolvePluginPath(value, '/work')).toBe(expected);
});

test.each([
  { value: 'a  \t\r\nb', expected: 'a\nb' },
  { value: '\n\na\n\n\n\nb  \n', expected: 'a\n\nb' },
  { value: `a${'\t'.repeat(100_000)}b`, expected: `a${'\t'.repeat(100_000)}b` },
  { value: undefined, expected: '' },
])('normalizeCliText trims line ends and collapses blank runs', async ({
  value,
  expected,
}) => {
  const { normalizeCliText } = await loadPluginCli();
  expect(normalizeCliText(value)).toBe(expected);
});
