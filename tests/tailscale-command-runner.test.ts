import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTailscaleCommandRunner } from '../src/tunnel/tailscale-command.js';

const execFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile }));

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

const ORIGINAL_PLATFORM = process.platform;
const MACOS_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  execFile.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Tailscale CLI discovery', () => {
  beforeEach(() => setPlatform('darwin'));

  it('prefers the PATH command on macOS', async () => {
    execFile.mockImplementation(
      (_command, _args, _options, callback: ExecFileCallback) =>
        callback(null, '1.0.0', ''),
    );

    await expect(
      createTailscaleCommandRunner(undefined, 5_000)(['version']),
    ).resolves.toEqual({ stdout: '1.0.0', stderr: '' });

    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      'tailscale',
      ['version'],
      { timeout: 5_000, windowsHide: true },
      expect.any(Function),
    );
  });

  it('uses the app CLI for login, start, health checks and stop when PATH lookup fails', async () => {
    const { TailscaleTunnelProvider } = await import(
      '../src/tunnel/tailscale-tunnel-provider.js'
    );
    vi.stubEnv('TAILSCALE_BE_CLI', '0');
    vi.stubEnv('TEST_TAILSCALE_PARENT', 'inherited');
    execFile.mockImplementation(
      (
        command: string,
        args: string[],
        options,
        callback: ExecFileCallback,
      ) => {
        if (command === 'tailscale') {
          callback(
            Object.assign(new Error('spawn tailscale ENOENT'), {
              code: 'ENOENT',
            }),
            '',
            '',
          );
          return;
        }
        expect(command).toBe(MACOS_TAILSCALE);
        expect(options.env.TAILSCALE_BE_CLI).toBe('1');
        expect(options.env.TEST_TAILSCALE_PARENT).toBe('inherited');
        expect(options.timeout).toBe(1_234);
        expect(options.shell).toBeUndefined();
        expect(args).not.toContain('test-auth-key');
        switch (args.join(' ')) {
          case 'status --json':
            callback(new Error('not logged in'), '', 'not logged in');
            return;
          case 'up':
            expect(options.env.TS_AUTHKEY).toBe('test-auth-key');
            callback(null, '', '');
            return;
          case 'funnel --bg localhost:9090':
            callback(null, 'https://runner.example.ts.net', '');
            return;
          case 'funnel status --json':
            callback(null, '{"URL":"https://runner.example.ts.net"}', '');
            return;
          case 'funnel --bg off':
            callback(null, '', '');
            return;
          default:
            callback(
              new Error(`unexpected command: ${args.join(' ')}`),
              '',
              '',
            );
        }
      },
    );
    const provider = new TailscaleTunnelProvider({
      commandTimeoutMs: 1_234,
      healthCheckIntervalMs: 1_000,
      readSecret: () => 'test-auth-key',
      recordAuditEvent: vi.fn(),
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://runner.example.ts.net',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.status()).toMatchObject({ running: true, state: 'up' });
    await expect(provider.stop()).resolves.toBeUndefined();
    expect(provider.status()).toMatchObject({ running: false, state: 'down' });
    expect(
      execFile.mock.calls
        .filter(([command]) => command === MACOS_TAILSCALE)
        .map(([, args]) => args),
    ).toEqual([
      ['status', '--json'],
      ['up'],
      ['funnel', '--bg', 'localhost:9090'],
      ['funnel', 'status', '--json'],
      ['funnel', '--bg', 'off'],
    ]);
    expect(process.env.TAILSCALE_BE_CLI).toBe('0');
  });

  it.each(['linux', 'win32'] as const)(
    'does not try the macOS app on %s',
    async (platform) => {
      setPlatform(platform);
      execFile.mockImplementation(
        (_command, _args, _options, callback: ExecFileCallback) =>
          callback(
            Object.assign(new Error('missing CLI'), { code: 'ENOENT' }),
            '',
            '',
          ),
      );

      await expect(
        createTailscaleCommandRunner(undefined, 5_000)(['version']),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(execFile).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['/custom/tailscale', 'tailscale'])(
    'respects the explicit command %s even when it is missing',
    async (command) => {
      execFile.mockImplementation(
        (_command, _args, _options, callback: ExecFileCallback) =>
          callback(
            Object.assign(new Error('missing CLI'), { code: 'ENOENT' }),
            '',
            '',
          ),
      );

      await expect(
        createTailscaleCommandRunner(command, 5_000)(['version']),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls[0][0]).toBe(command);
    },
  );

  it.each(['EACCES', 'ETIMEDOUT', 1])(
    'does not mask a PATH command failure with code %s',
    async (code) => {
      execFile.mockImplementation(
        (_command, _args, _options, callback: ExecFileCallback) =>
          callback(
            Object.assign(new Error('command failed'), { code }),
            '',
            'daemon unavailable',
          ),
      );

      await expect(
        createTailscaleCommandRunner(undefined, 5_000)(['status', '--json']),
      ).rejects.toMatchObject({ code, message: 'daemon unavailable' });
      expect(execFile).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['ENOENT', 'EACCES', 1])(
    'propagates app CLI failures with code %s and preserves the timeout override',
    async (code) => {
      execFile.mockImplementation(
        (command, _args, _options, callback: ExecFileCallback) => {
          const errorCode = command === 'tailscale' ? 'ENOENT' : code;
          callback(
            Object.assign(new Error('app CLI failed'), { code: errorCode }),
            '',
            '',
          );
        },
      );

      await expect(
        createTailscaleCommandRunner(undefined, 5_000)(['version'], {
          timeoutMs: 1_234,
        }),
      ).rejects.toMatchObject({ code });
      expect(execFile).toHaveBeenCalledTimes(2);
      expect(execFile.mock.calls[1]).toEqual([
        MACOS_TAILSCALE,
        ['version'],
        expect.objectContaining({ timeout: 1_234 }),
        expect.any(Function),
      ]);
    },
  );
});

describe('TailscaleTunnelProvider default command runner', () => {
  it('passes TS_AUTHKEY through execFile env instead of argv', async () => {
    const { TailscaleTunnelProvider } = await import(
      '../src/tunnel/tailscale-tunnel-provider.js'
    );
    execFile.mockImplementation(
      (
        command: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv },
        callback: ExecFileCallback,
      ) => {
        if (args.join(' ') === 'status --json') {
          callback(new Error('not logged in'), '', 'not logged in');
          return;
        }
        if (args.join(' ') === 'up') {
          expect(command).toBe('tailscale');
          expect(args).toEqual(['up']);
          expect(args).not.toContain('test-auth-key');
          expect(options.env.TS_AUTHKEY).toBe('test-auth-key');
          callback(null, '', '');
          return;
        }
        if (args.join(' ') === 'funnel --bg localhost:9090') {
          callback(
            null,
            'Available on the internet:\nhttps://runner.example.ts.net\n',
            '',
          );
          return;
        }
        callback(new Error(`unexpected command: ${args.join(' ')}`), '', '');
      },
    );

    const provider = new TailscaleTunnelProvider({
      readSecret: () => 'test-auth-key',
      recordAuditEvent: vi.fn(),
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://runner.example.ts.net',
    });
  });

  it('turns an ENOENT from execFile into actionable CLI guidance', async () => {
    const { TailscaleTunnelProvider } = await import(
      '../src/tunnel/tailscale-tunnel-provider.js'
    );
    execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: ExecFileCallback,
      ) => {
        callback(
          Object.assign(new Error('spawn /custom/tailscale ENOENT'), {
            code: 'ENOENT',
          }),
          '',
          '',
        );
      },
    );
    const provider = new TailscaleTunnelProvider({
      readSecret: () => null,
      recordAuditEvent: vi.fn(),
      tailscaleCommand: '/custom/tailscale',
    });

    await expect(provider.start()).rejects.toThrow(
      'Tailscale CLI was not found in the gateway runtime.',
    );
    expect(provider.status().last_error).toContain(
      'host or container running HybridClaw',
    );
    expect(provider.status().last_error).toContain('managed cloud service');
    expect(provider.status().last_error).not.toContain('ENOENT');
  });
});
