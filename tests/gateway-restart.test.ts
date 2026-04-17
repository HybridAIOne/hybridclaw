import { describe, expect, test, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import {
  getGatewayLifecycleStatus,
  normalizeGatewayRestartCommand,
  requestExternalGatewayRestart,
  requestGatewayRestart,
  runGatewayRestartHelperFromArg,
} from '../src/gateway/gateway-restart.js';

describe('gateway restart helpers', () => {
  test('normalizes replayed gateway commands to use start --foreground', () => {
    expect(
      normalizeGatewayRestartCommand([
        process.execPath,
        '/tmp/dist/cli.js',
        'gateway',
        'restart',
        '--debug',
      ]),
    ).toEqual([
      process.execPath,
      '/tmp/dist/cli.js',
      'gateway',
      'start',
      '--foreground',
      '--debug',
    ]);
  });

  test('reports restart unsupported when the pid file does not match the current process', () => {
    expect(
      getGatewayLifecycleStatus({
        currentPid: 99,
        state: {
          pid: 42,
          startedAt: '',
          cwd: '/tmp',
          command: [process.execPath, '/tmp/dist/cli.js', 'gateway', 'start'],
        },
      }),
    ).toEqual({
      restartSupported: false,
      restartReason:
        'Gateway restart is unavailable: this process is not the active CLI-managed gateway.',
    });
  });

  test('spawns a detached CLI helper to restart the gateway', () => {
    const result = requestGatewayRestart({
      currentPid: 42,
      state: {
        pid: 42,
        startedAt: '',
        cwd: '/tmp/hybridclaw',
        command: [
          process.execPath,
          '/tmp/dist/cli.js',
          'gateway',
          'restart',
          '--foreground',
          '--debug',
        ],
      },
    });

    expect(result).toEqual({
      restartSupported: true,
      restartReason: null,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/dist/cli.js', '__gateway-restart-helper', expect.any(String)],
      expect.objectContaining({
        cwd: '/tmp/hybridclaw',
        detached: true,
        stdio: 'ignore',
      }),
    );

    const payload = JSON.parse(
      Buffer.from(spawnMock.mock.calls[0]?.[1]?.[2], 'base64url').toString(
        'utf-8',
      ),
    ) as {
      parentPid: number;
      cwd: string;
      command: string[];
    };
    expect(payload).toEqual({
      parentPid: 42,
      cwd: '/tmp/hybridclaw',
      command: [
        process.execPath,
        '/tmp/dist/cli.js',
        'gateway',
        'start',
        '--foreground',
        '--debug',
      ],
    });
  });

  test('external restart reports not-running when no PID file exists', () => {
    spawnMock.mockClear();
    const result = requestExternalGatewayRestart({ state: null });
    expect(result).toEqual({ status: 'not-running', pid: null, reason: null });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('external restart reports not-running when the recorded PID is dead', () => {
    spawnMock.mockClear();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid: number, _signal?: string | number) => {
        throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      });

    const result = requestExternalGatewayRestart({
      state: {
        pid: 999_999,
        startedAt: '',
        cwd: '/tmp',
        command: [process.execPath, '/tmp/dist/cli.js', 'gateway', 'start'],
      },
    });

    expect(result).toEqual({
      status: 'not-running',
      pid: 999_999,
      reason: null,
    });
    expect(spawnMock).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  test('external restart spawns helper with gateway PID and signals SIGTERM', () => {
    spawnMock.mockClear();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true as unknown as boolean);

    const result = requestExternalGatewayRestart({
      state: {
        pid: 4242,
        startedAt: '',
        cwd: '/tmp/hybridclaw',
        command: [
          process.execPath,
          '/tmp/dist/cli.js',
          'gateway',
          'start',
          '--debug',
        ],
      },
    });

    expect(result).toEqual({ status: 'restarted', pid: 4242, reason: null });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/dist/cli.js', '__gateway-restart-helper', expect.any(String)],
      expect.objectContaining({
        cwd: '/tmp/hybridclaw',
        detached: true,
        stdio: 'ignore',
      }),
    );

    const payload = JSON.parse(
      Buffer.from(spawnMock.mock.calls[0]?.[1]?.[2], 'base64url').toString(
        'utf-8',
      ),
    ) as { parentPid: number; cwd: string; command: string[] };
    expect(payload).toEqual({
      parentPid: 4242,
      cwd: '/tmp/hybridclaw',
      command: [
        process.execPath,
        '/tmp/dist/cli.js',
        'gateway',
        'start',
        '--foreground',
        '--debug',
      ],
    });

    expect(killSpy).toHaveBeenCalledWith(4242, 0);
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    killSpy.mockRestore();
  });

  test('external restart reports failure when signalling the gateway fails', () => {
    spawnMock.mockClear();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid: number, signal?: string | number) => {
        if (signal === 'SIGTERM') {
          throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        }
        return true as unknown as boolean;
      });

    const result = requestExternalGatewayRestart({
      state: {
        pid: 4242,
        startedAt: '',
        cwd: '/tmp/hybridclaw',
        command: [process.execPath, '/tmp/dist/cli.js', 'gateway', 'start'],
      },
    });

    expect(result.status).toBe('failed');
    expect(result.pid).toBe(4242);
    expect(result.reason).toMatch(/Failed to signal gateway pid 4242/);
    killSpy.mockRestore();
  });

  test('helper relaunches the normalized gateway command after the parent exits', async () => {
    spawnMock.mockClear();

    const payload = Buffer.from(
      JSON.stringify({
        parentPid: 0,
        cwd: '/tmp/hybridclaw',
        command: [
          process.execPath,
          '/tmp/dist/cli.js',
          'gateway',
          'start',
          '--foreground',
        ],
      }),
      'utf-8',
    ).toString('base64url');

    await runGatewayRestartHelperFromArg(payload);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/dist/cli.js', 'gateway', 'start', '--foreground'],
      expect.objectContaining({
        cwd: '/tmp/hybridclaw',
        detached: true,
        stdio: 'ignore',
      }),
    );
  });
});
