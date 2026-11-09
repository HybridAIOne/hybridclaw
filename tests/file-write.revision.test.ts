import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir('write-revision-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

test('a failed revision read cannot leave the sandbox write lock behind', async () => {
  const root = tempDir();
  const target = path.join(root, 'note.txt');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(target, 'original');
  fs.writeFileSync(path.join(bin, 'sha256sum'), '#!/bin/sh\nexit 1\n', {
    mode: 0o755,
  });
  const { runFileWrite } = await import('../container/src/tools/file-write.js');
  await expect(
    runFileWrite(
      {
        path: 'note.txt',
        contents: 'replacement',
        overwrite: true,
        expected_content: 'wrong',
      },
      () => target,
      {
        container: 'fixture',
        run: ({ args, input }) => {
          const result = spawnSync('bash', args.slice(4), {
            input,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            status: result.status,
          };
        },
      },
    ),
  ).rejects.toThrow(/Stale/);
  expect(fs.readFileSync(target, 'utf8')).toBe('original');
  expect(fs.existsSync(`${target}.lock`)).toBe(false);
  expect(fs.readdirSync(root).sort()).toEqual(['bin', 'note.txt']);
});

test('returned revision permits checked recovery and releases the mutation fence', async () => {
  const root = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  const { runFileWrite } = await import('../container/src/tools/file-write.js');
  const { TrustedAgentApprovalRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(root, 'policy.yaml'),
  );
  runtime.setSession('session-a');
  runtime.setApprovalMode({ mode: 'full' });
  const blocked = () =>
    runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'printf ok > done.txt' }),
    }).pinned;
  const write = (args: Record<string, unknown>) =>
    runFileWrite(args, (f) => path.join(root, f), undefined, 'session-a');
  const original = 'original\r\n';
  expect(await write({ path: 'note.txt', contents: original })).toContain(
    hash(original),
  );
  await expect(
    write({ path: 'note.txt', contents: 'revised' }),
  ).rejects.toThrow(hash(original));
  expect(blocked()).toBe(true);
  await write({
    path: 'note.txt',
    contents: 'revised',
    overwrite: true,
    expected_sha256: hash(original),
  });
  expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('revised');
  expect(blocked()).toBe(false);
});

test.each(['newer\n', 'original', 'original\n'])(
  'a stale revision cannot replace changed bytes: %j',
  async (current) => {
    const root = tempDir();
    const file = path.join(root, 'note.txt');
    fs.writeFileSync(file, current);
    const { runFileWrite } = await import(
      '../container/src/tools/file-write.js'
    );
    await expect(
      runFileWrite(
        {
          path: 'note.txt',
          contents: 'replacement',
          overwrite: true,
          expected_sha256: hash('original\r\n'),
        },
        () => file,
      ),
    ).rejects.toThrow(/Stale/);
    expect(fs.readFileSync(file, 'utf8')).toBe(current);
  },
);

test.each([
  { expected_sha256: 'invalid', overwrite: true },
  { expected_sha256: hash('original') },
  {
    expected_sha256: hash('original'),
    expected_content: 'original',
    overwrite: true,
  },
])('invalid revision arguments leave the file untouched: %j', async (extra) => {
  const root = tempDir();
  const file = path.join(root, 'note.txt');
  fs.writeFileSync(file, 'original');
  const { runFileWrite } = await import('../container/src/tools/file-write.js');
  await expect(
    runFileWrite(
      { path: 'note.txt', contents: 'replacement', ...extra },
      () => file,
    ),
  ).rejects.toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe('original');
});
