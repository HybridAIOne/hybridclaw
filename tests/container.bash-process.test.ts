import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { expectProcessStopped } from './helpers/process-state.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hc-bash-process-');
let shell: typeof import('../container/src/bash-process.js') | undefined;
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllEnvs: true,
  cleanup: async () => {
    await shell?.cancelBashProcesses();
  },
});

async function runtime() {
  const dir = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', dir);
  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', '');
  shell = await import('../container/src/bash-process.js');
  const run = (command: string, timeoutMs = 5_000) =>
    shell!.runBashProcess(
      ['-c', 'IFS= read -r -d \'\' command || exit 125; eval "$command"'],
      { command, timeoutMs, runtimeEnv: {} },
    );
  return { dir, run, shell };
}

const treeCommand =
  'trap "" TERM; bash -c \'trap "" TERM; sleep 30 & echo $! > grandchild.pid; wait\' & echo $! > child.pid; wait';

test('timeout kills TERM-resistant descendants and retains partial output', async () => {
  const { dir, run } = await runtime();
  const result = await run(`printf partial; ${treeCommand}`, 300);
  expect(result.error?.message).toContain('ETIMEDOUT');
  expect(result.stdout).toBe('partial');
  for (const file of ['child.pid', 'grandchild.pid']) {
    await expectProcessStopped(
      Number(fs.readFileSync(path.join(dir, file), 'utf8')),
    );
  }
});

test('a new sandbox OOM kill interrupts an active command', async () => {
  const { run } = await runtime();
  vi.stubEnv('HYBRIDCLAW_AGENT_DEDICATED_CGROUP', '1');
  let kills = 1;
  const readFile = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) =>
    file === '/sys/fs/cgroup/memory.events'
      ? `low 0\noom_kill ${kills}\n`
      : readFile(file, options),
  );
  const resultPromise = run('printf partial; sleep 30', 3_000);
  kills += 1;
  const result = await resultPromise;
  expect(result.error?.message).toContain('out-of-memory kill');
  expect(result.stdout).toBe('partial');
  expect(await run('printf recovered')).toMatchObject({
    error: undefined,
    status: 0,
    stdout: 'recovered',
  });
});

test('ignores cgroup counters when the worker does not own the sandbox', async () => {
  const { run } = await runtime();
  vi.stubEnv('HYBRIDCLAW_AGENT_DEDICATED_CGROUP', '');
  const readFile = vi.spyOn(fs, 'readFileSync');
  expect(await run('true')).toMatchObject({ status: 0, error: undefined });
  expect(readFile.mock.calls.map(([file]) => file)).not.toContain(
    '/sys/fs/cgroup/memory.events',
  );
});

test('shutdown cancels every active process group and is idempotent', async () => {
  const { dir, run, shell } = await runtime();
  const first = run(treeCommand);
  const second = run(
    'trap "" TERM; printf ready > ready; while :; do sleep 1; done',
  );
  await vi.waitFor(() => {
    expect(fs.existsSync(path.join(dir, 'grandchild.pid'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ready'))).toBe(true);
  });
  await Promise.all([shell.cancelBashProcesses(), shell.cancelBashProcesses()]);
  for (const result of await Promise.all([first, second])) {
    expect(result.error?.message).toContain('cancelled');
  }
  await expectProcessStopped(
    Number(fs.readFileSync(path.join(dir, 'grandchild.pid'), 'utf8')),
  );
  await shell.cancelBashProcesses();
});

test.each(['stdout', 'stderr', 'combined'])(
  'bounds %s output and cancels an overflowing command',
  async (stream) => {
    const { run, shell } = await runtime();
    const out = 'head -c 3145728 /dev/zero';
    const command =
      stream === 'combined'
        ? `${out}; ${out} >&2`
        : `head -c 5242880 /dev/zero ${stream === 'stderr' ? '>&2' : ''}; sleep 30`;
    const result = await run(command);
    expect(result.error?.message).toContain('output exceeded');
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBe(shell.BASH_EXEC_MAX_BUFFER_BYTES);
  },
);

test('collects UTF-8 split across pipe chunks and preserves stderr and status', async () => {
  const { run } = await runtime();
  const result = await run(
    "printf '\\342'; sleep 0.02; printf '\\202\\254'; printf problem >&2; exit 7",
  );
  expect(result).toMatchObject({
    stdout: '€',
    stderr: 'problem',
    status: 7,
    error: undefined,
  });
});

test('reports launch failures without hanging', async () => {
  const { dir, run } = await runtime();
  fs.rmdirSync(dir);
  const result = await run('true');
  expect(result.error).toMatchObject({ code: 'ENOENT' });
});
