import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const requestExternalGatewayRestartMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock('../src/gateway/gateway-restart.js', () => ({
  requestExternalGatewayRestart: requestExternalGatewayRestartMock,
}));

describe('runUpdateCommand', () => {
  const originalArgv = [...process.argv];
  const originalCwd = process.cwd();
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;
  let tempDir = '';

  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    requestExternalGatewayRestartMock.mockReset();
    requestExternalGatewayRestartMock.mockReturnValue({
      status: 'not-running',
      pid: null,
      reason: null,
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-update-'));
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.chdir(originalCwd);
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      configurable: true,
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setupPackageInstall(version: string) {
    const installRoot = path.join(
      tempDir,
      'node_modules',
      '@hybridaione',
      'hybridclaw',
    );
    fs.mkdirSync(path.join(installRoot, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, 'package.json'),
      JSON.stringify({
        name: '@hybridaione/hybridclaw',
        version,
      }),
    );
    process.chdir(tempDir);
    process.argv = [
      originalArgv[0] || 'node',
      path.join(installRoot, 'dist', 'cli.js'),
    ];
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });

    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'view') {
        return { status: 0, stdout: '0.12.0\n', stderr: '' };
      }
      if (command === 'npm' && args[0] === '--version') {
        return { status: 0, stdout: '10.0.0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    spawnMock.mockImplementation(() => ({
      on(event: string, handler: (value?: number) => void) {
        if (event === 'close') {
          handler(0);
        }
      },
    }));
  }

  it('skips the restart message when no gateway is running', async () => {
    setupPackageInstall('0.9.8');
    requestExternalGatewayRestartMock.mockReturnValue({
      status: 'not-running',
      pid: null,
      reason: null,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runUpdateCommand } = await import('../src/update.js');
    await runUpdateCommand(['--yes'], '0.9.8');

    expect(requestExternalGatewayRestartMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@hybridaione/hybridclaw@latest'],
      { stdio: 'inherit' },
    );
    const messages = logSpy.mock.calls.map((call) => call[0]);
    expect(messages).not.toContain(
      'If the gateway is already running, restart it to load the new version:',
    );
    expect(messages).not.toContain('  hybridclaw gateway restart');
    expect(messages).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^Restarting gateway/)]),
    );
  });

  it('restarts a running gateway with original parameters after install', async () => {
    setupPackageInstall('0.9.8');
    requestExternalGatewayRestartMock.mockReturnValue({
      status: 'restarted',
      pid: 4242,
      reason: null,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runUpdateCommand } = await import('../src/update.js');
    await runUpdateCommand(['--yes'], '0.9.8');

    expect(requestExternalGatewayRestartMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      'Restarting gateway (pid 4242) with original parameters to load the new version.',
    );
  });

  it('falls back to manual restart instructions when auto-restart fails', async () => {
    setupPackageInstall('0.9.8');
    requestExternalGatewayRestartMock.mockReturnValue({
      status: 'failed',
      pid: 4242,
      reason: 'Failed to signal gateway pid 4242: EPERM',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runUpdateCommand } = await import('../src/update.js');
    await runUpdateCommand(['--yes'], '0.9.8');

    expect(logSpy).toHaveBeenCalledWith(
      'Could not auto-restart gateway (pid 4242): Failed to signal gateway pid 4242: EPERM',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'To load the new version, run: hybridclaw gateway restart',
    );
  });
});
