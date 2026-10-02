/**
 * Approved shells run without blocking the worker, with bounded output and
 * process-group cancellation on timeout or shutdown (including docker exec).
 * Unlike the bash dispatcher, this module neither approves commands nor resolves
 * credentials: command text stays on stdin and credential values stay in env.
 */
import { spawn } from 'node:child_process';
import { buildSanitizedEnv } from '../shared/sensitive-env.js';
import { WORKSPACE_ROOT } from './runtime-paths.js';

export const BASH_EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
export const BASH_DOCKER_CONTAINER = String(
  process.env.HYBRIDCLAW_BASH_DOCKER_CONTAINER || '',
).trim();
export const BASH_DOCKER_CWD = String(
  process.env.HYBRIDCLAW_BASH_DOCKER_CWD || '/app',
).trim();
export const TASK_SANDBOX_FS_ENABLED = Boolean(BASH_DOCKER_CONTAINER);

export type BashProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

// 2026-10-02, Codex: allow TERM handlers 250ms, then kill the entire group;
// configurable grace periods and background-job management are deferred.
const KILL_GRACE_MS = 250;
const DOCKER_PID_PREFIX = 'hybridclaw-bash-pgid:';
const DOCKER_PID_MAX_BYTES =
  DOCKER_PID_PREFIX.length + String(Number.MAX_SAFE_INTEGER).length;

// Monitor mode assigns the command its own group without requiring setsid in
// arbitrary task images. Disable job notifications after starting the group.
const DOCKER_WRAPPER = `set -m
bash "$@" <&0 &
__hybridclaw_pid=$!
set +m
wait "$__hybridclaw_pid"`;
// Report the group before exec so login startup output cannot race the header.
const DOCKER_GROUP_WRAPPER = `printf '${DOCKER_PID_PREFIX}%s\\n' "$$"
exec bash "$@"`;
const DOCKER_CANCEL_WRAPPER = `IFS= read -r -d '' __hybridclaw_pid || exit 125
case "$__hybridclaw_pid" in ''|*[!0-9]*) exit 125;; esac
kill -TERM -- "-$__hybridclaw_pid" 2>/dev/null || true
sleep ${KILL_GRACE_MS / 1000}
kill -KILL -- "-$__hybridclaw_pid" 2>/dev/null || true`;

const activeCommands = new Set<() => Promise<void>>();

/** Shutdown waits for tree cancellation and command pipe closure before exit. */
export async function cancelBashProcesses(): Promise<void> {
  await Promise.all([...activeCommands].map((cancel) => cancel()));
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function cancelDockerGroup(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(
      'docker',
      [
        'exec',
        '-i',
        BASH_DOCKER_CONTAINER,
        'bash',
        '-c',
        DOCKER_CANCEL_WRAPPER,
      ],
      { env: process.env, stdio: ['pipe', 'ignore', 'ignore'], detached: true },
    );
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
    }, 5_000);
    killer.stdin.on('error', () => {});
    killer.once('error', reject);
    killer.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error('Unable to cancel the task sandbox shell process group'),
        );
    });
    killer.stdin.end(`${pid}\0`);
  });
}

export async function runBashProcess(
  args: string[],
  params: {
    command: string;
    timeoutMs: number;
    runtimeEnv: Record<string, string>;
  },
  stdinFields: string[] = [],
): Promise<BashProcessResult> {
  const env = buildSanitizedEnv(process.env);
  const gatewayUrl = String(process.env.HYBRIDCLAW_GATEWAY_URL || '').trim();
  const gatewayToken = String(
    process.env.HYBRIDCLAW_GATEWAY_TOKEN || '',
  ).trim();
  if (gatewayUrl) env.HYBRIDCLAW_GATEWAY_URL = gatewayUrl;
  if (gatewayToken) env.HYBRIDCLAW_GATEWAY_TOKEN = gatewayToken;
  const child = TASK_SANDBOX_FS_ENABLED
    ? spawn(
        'docker',
        [
          'exec',
          '-i',
          '-w',
          BASH_DOCKER_CWD || '/app',
          ...Object.keys(params.runtimeEnv).flatMap((name) => ['-e', name]),
          BASH_DOCKER_CONTAINER,
          'bash',
          '-c',
          DOCKER_WRAPPER,
          'hybridclaw-docker-wrapper',
          '-c',
          DOCKER_GROUP_WRAPPER,
          'hybridclaw-bash-group',
          ...args,
        ],
        { env: { ...process.env, ...params.runtimeEnv }, detached: true },
      )
    : spawn('bash', args, {
        cwd: WORKSPACE_ROOT,
        env: { ...env, ...params.runtimeEnv },
        detached: true,
      });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let error: Error | undefined;
  let cancellation: Promise<void> | undefined;
  let dockerPid: number | null = null;
  let dockerHeader = Buffer.alloc(0);
  let resolveDockerPid!: (pid: number | null) => void;
  const dockerReady = new Promise<number | null>((resolve) => {
    resolveDockerPid = resolve;
  });
  const closed = new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('close', (status, signal) => {
      resolveDockerPid(null);
      resolve({ status, signal });
    });
  });
  const cancel = (
    reason = new Error('Command cancelled during worker shutdown'),
  ): Promise<void> => {
    if (cancellation) return cancellation;
    error = reason;
    cancellation = (async () => {
      try {
        if (TASK_SANDBOX_FS_ENABLED) {
          const pid =
            dockerPid ??
            (await new Promise<number | null>((resolve, reject) => {
              const readyTimeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      'Task sandbox shell did not report its process group',
                    ),
                  ),
                5_000,
              );
              void dockerReady.then((pid) => {
                clearTimeout(readyTimeout);
                resolve(pid);
              });
            }));
          if (pid !== null) await cancelDockerGroup(pid);
        } else if (child.pid) {
          killGroup(child.pid, 'SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
          killGroup(child.pid, 'SIGKILL');
        }
      } catch (cause) {
        error = new Error(
          `${reason.message}; ${cause instanceof Error ? cause.message : 'process cancellation failed'}`,
        );
      } finally {
        if (TASK_SANDBOX_FS_ENABLED) child.kill('SIGKILL');
      }
      await closed;
    })();
    return cancellation;
  };
  const shutdownCancel = () => cancel();
  activeCommands.add(shutdownCancel);
  const timer = setTimeout(() => {
    void cancel(
      new Error(`ETIMEDOUT: Command timed out after ${params.timeoutMs}ms`),
    );
  }, params.timeoutMs);
  const collect = (chunks: Buffer[], chunk: Buffer) => {
    const remaining = BASH_EXEC_MAX_BUFFER_BYTES - bytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      chunks.push(Buffer.from(retained));
      bytes += retained.length;
    }
    if (chunk.length > remaining) {
      void cancel(
        new Error(
          `Command output exceeded ${BASH_EXEC_MAX_BUFFER_BYTES} bytes`,
        ),
      );
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (TASK_SANDBOX_FS_ENABLED && dockerPid === null) {
      dockerHeader = Buffer.concat([dockerHeader, chunk]);
      const newline = dockerHeader.indexOf(10);
      if (newline < 0 && dockerHeader.length <= DOCKER_PID_MAX_BYTES) return;
      const line = dockerHeader.subarray(0, newline).toString();
      const pidText = line.startsWith(DOCKER_PID_PREFIX)
        ? line.slice(DOCKER_PID_PREFIX.length)
        : '';
      const pid = Number(pidText);
      if (
        newline < 0 ||
        newline > DOCKER_PID_MAX_BYTES ||
        !/^[1-9]\d*$/.test(pidText) ||
        pid <= 1 ||
        !Number.isSafeInteger(pid)
      ) {
        error = new Error('Invalid task sandbox shell process group');
        dockerHeader = Buffer.alloc(0);
        child.kill('SIGKILL');
        return;
      }
      dockerPid = pid;
      resolveDockerPid(dockerPid);
      chunk = dockerHeader.subarray(newline + 1);
      dockerHeader = Buffer.alloc(0);
    }
    collect(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
  child.once('error', (cause) => {
    error ??= cause;
  });
  // A command may exit without reading the entire frame; EPIPE is expected.
  child.stdin.on('error', (cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EPIPE') void cancel(cause);
  });
  child.stdin.end(
    [...stdinFields, params.command].map((field) => `${field}\0`).join(''),
  );
  try {
    const result = await closed;
    await cancellation;
    return {
      ...result,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      error,
    };
  } finally {
    clearTimeout(timer);
    activeCommands.delete(shutdownCancel);
  }
}
