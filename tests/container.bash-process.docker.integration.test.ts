import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const exec = promisify(execFile);

describe
  .skipIf(process.env.HYBRIDCLAW_TEST_DOCKER !== '1')
  .sequential('async bash in a real task sandbox', () => {
    const container = `hc-bash-test-${randomUUID()}`;
    let shell: typeof import('../container/src/bash-session.js');
    let processes: typeof import('../container/src/bash-process.js');
    const docker = (...args: string[]) =>
      exec('docker', args, { timeout: 10_000 });

    beforeAll(async () => {
      await docker(
        'run',
        '-d',
        '--name',
        container,
        '-w',
        '/tmp',
        '--entrypoint',
        'sleep',
        'node:22-slim',
        'infinity',
      );
      vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', container);
      vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CWD', '/tmp');
      processes = await import('../container/src/bash-process.js');
      shell = await import('../container/src/bash-session.js');
    });
    afterAll(async () => {
      await processes?.cancelBashProcesses();
      await shell?.resetPersistentBashSessions();
      await docker('rm', '-f', container);
      vi.unstubAllEnvs();
      vi.resetModules();
    });
    const run = (command: string, timeoutMs = 5_000, runtimeEnv = {}) =>
      shell.runBash({
        command,
        timeoutMs,
        runtimeEnv,
        sessionId: 'docker-shell',
      });

    test('preserves state, EOF, refreshed credentials and exact output through the process-group wrapper', async () => {
      for (let turn = 0; turn < 20; turn++) {
        const { result } = await run('printf output; printf error >&2');
        expect(result).toMatchObject({
          status: 0,
          stdout: 'output',
          stderr: 'error',
          error: undefined,
        });
      }
      await run(
        'mkdir -p nested; cd nested; export TEST_VAR=kept; alias probe="printf alias"',
      );
      expect(
        (
          await run(
            'printf "%s:%s:%s:" "$PWD" "$TEST_VAR" "$GOG_ACCESS_TOKEN"; probe',
            5_000,
            { GOG_ACCESS_TOKEN: 'test-key' },
          )
        ).result.stdout,
      ).toBe('/tmp/nested:kept:test-key:alias');
      expect(
        (
          await run(
            'printf "%s:" "$GOG_ACCESS_TOKEN"; if read line; then printf bad; else printf eof; fi',
          )
        ).result.stdout,
      ).toBe(':eof');
      expect((await run('printf failed; exit 7')).result).toMatchObject({
        status: 7,
        stdout: 'failed',
      });
    });

    test.each(['timeout', 'shutdown'])(
      'cancels the remote tree on %s and leaves the sandbox usable',
      async (mode) => {
        const pidFile = `/tmp/${mode}.pid`;
        const work = run(
          `trap "" TERM; bash -c 'trap "" TERM; sleep 30 & echo $! > ${pidFile}; wait' & wait`,
          mode === 'timeout' ? 500 : 5_000,
        );
        await vi.waitFor(async () => {
          expect(
            (await docker('exec', container, 'cat', pidFile)).stdout.trim(),
          ).toMatch(/^\d+$/);
        });
        if (mode === 'shutdown') await processes.cancelBashProcesses();
        const { result } = await work;
        expect(result.error?.message).toContain(
          mode === 'timeout' ? 'ETIMEDOUT' : 'cancelled',
        );
        const pid = (
          await docker('exec', container, 'cat', pidFile)
        ).stdout.trim();
        // Container init may retain an orphan zombie; it must no longer execute.
        const { stdout } = await docker(
          'exec',
          container,
          'bash',
          '-c',
          `if test -e /proc/${pid}/stat; then cat /proc/${pid}/stat; fi`,
        );
        expect(stdout === '' || /^\d+ \(.*\) Z /.test(stdout)).toBe(true);
        expect((await run('printf usable')).result.stdout).toBe('usable');
      },
    );

    test('output overflow cancels the remote command', async () => {
      const { result } = await run('head -c 5242880 /dev/zero; sleep 30');
      expect(result.error?.message).toContain('output exceeded');
      expect(Buffer.byteLength(result.stdout)).toBe(
        processes.BASH_EXEC_MAX_BUFFER_BYTES,
      );
    });
  });
