import { describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile }));

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

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
});
