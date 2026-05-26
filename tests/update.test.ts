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
  const originalNpmConfigUserAgent = process.env.npm_config_user_agent;
  const originalNpmExecpath = process.env.npm_execpath;
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
    if (originalNpmConfigUserAgent === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = originalNpmConfigUserAgent;
    }
    if (originalNpmExecpath === undefined) {
      delete process.env.npm_execpath;
    } else {
      process.env.npm_execpath = originalNpmExecpath;
    }
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
    fs.mkdirSync(path.join(installRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, 'package.json'),
      JSON.stringify({
        name: '@hybridaione/hybridclaw',
        version,
      }),
    );
    fs.writeFileSync(
      path.join(installRoot, 'scripts', 'postinstall-container.mjs'),
      '',
      'utf-8',
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
      if (command === 'npm' && args[0] === 'rebuild') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        command === process.execPath &&
        args[0] ===
          path.join(installRoot, 'scripts', 'postinstall-container.mjs')
      ) {
        return { status: 0, stdout: '', stderr: '' };
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

    return { installRoot };
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
      ['install', '-g', '--ignore-scripts', '@hybridaione/hybridclaw@latest'],
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

  it('runs explicit postinstall from the updated global package root', async () => {
    const { installRoot } = setupPackageInstall('0.9.8');
    const globalNodeModules = path.join(tempDir, 'global', 'node_modules');
    const updatedRoot = path.join(
      globalNodeModules,
      '@hybridaione',
      'hybridclaw',
    );
    fs.mkdirSync(path.join(updatedRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(updatedRoot, 'package.json'),
      JSON.stringify({
        name: '@hybridaione/hybridclaw',
        version: '0.12.0',
      }),
    );
    fs.writeFileSync(
      path.join(updatedRoot, 'scripts', 'postinstall-container.mjs'),
      '',
      'utf-8',
    );

    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'view') {
        return { status: 0, stdout: '0.12.0\n', stderr: '' };
      }
      if (command === 'npm' && args[0] === '--version') {
        return { status: 0, stdout: '10.0.0\n', stderr: '' };
      }
      if (command === 'npm' && args.join(' ') === 'root -g') {
        return { status: 0, stdout: `${globalNodeModules}\n`, stderr: '' };
      }
      if (command === 'npm' && args[0] === 'rebuild') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        command === process.execPath &&
        args[0] ===
          path.join(updatedRoot, 'scripts', 'postinstall-container.mjs')
      ) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        command === process.execPath &&
        args[0] ===
          path.join(installRoot, 'scripts', 'postinstall-container.mjs')
      ) {
        return { status: 12, stdout: '', stderr: 'old postinstall' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    const { runUpdateCommand } = await import('../src/update.js');
    await runUpdateCommand(['--yes'], '0.9.8');

    expect(spawnSyncMock).toHaveBeenCalledWith('npm', ['root', '-g'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'npm',
      [
        'rebuild',
        'better-sqlite3',
        'node-pty',
        'onnxruntime-node',
        '--ignore-scripts=false',
        '--no-audit',
        '--fund=false',
      ],
      expect.objectContaining({
        cwd: updatedRoot,
        stdio: 'inherit',
      }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      [path.join(updatedRoot, 'scripts', 'postinstall-container.mjs')],
      { stdio: 'inherit' },
    );
  });

  it('runs explicit postinstall from the updated bun global package root', async () => {
    const { installRoot } = setupPackageInstall('0.9.8');
    const globalBin = path.join(tempDir, 'bun-global', 'bin');
    const globalNodeModules = path.join(
      tempDir,
      'bun-global',
      'install',
      'global',
      'node_modules',
    );
    const updatedRoot = path.join(
      globalNodeModules,
      '@hybridaione',
      'hybridclaw',
    );
    fs.mkdirSync(path.join(updatedRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(updatedRoot, 'package.json'),
      JSON.stringify({
        name: '@hybridaione/hybridclaw',
        version: '0.12.0',
      }),
    );
    fs.writeFileSync(
      path.join(updatedRoot, 'scripts', 'postinstall-container.mjs'),
      '',
      'utf-8',
    );
    process.env.npm_config_user_agent =
      'bun/1.2.0 npm/? node/v22.22.3 darwin arm64';

    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'view') {
        return { status: 0, stdout: '0.12.0\n', stderr: '' };
      }
      if (command === 'bun' && args[0] === '--version') {
        return { status: 0, stdout: '1.2.0\n', stderr: '' };
      }
      if (command === 'bun' && args.join(' ') === 'pm bin -g') {
        return { status: 0, stdout: `${globalBin}\n`, stderr: '' };
      }
      if (command === 'npm' && args[0] === 'rebuild') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        command === process.execPath &&
        args[0] ===
          path.join(updatedRoot, 'scripts', 'postinstall-container.mjs')
      ) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        command === process.execPath &&
        args[0] ===
          path.join(installRoot, 'scripts', 'postinstall-container.mjs')
      ) {
        return { status: 12, stdout: '', stderr: 'old postinstall' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    const { runUpdateCommand } = await import('../src/update.js');
    await runUpdateCommand(['--yes'], '0.9.8');

    expect(spawnMock).toHaveBeenCalledWith(
      'bun',
      ['add', '-g', '--ignore-scripts', '@hybridaione/hybridclaw@latest'],
      { stdio: 'inherit' },
    );
    expect(spawnSyncMock).toHaveBeenCalledWith('bun', ['pm', 'bin', '-g'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'npm',
      [
        'rebuild',
        'better-sqlite3',
        'node-pty',
        'onnxruntime-node',
        '--ignore-scripts=false',
        '--no-audit',
        '--fund=false',
      ],
      expect.objectContaining({
        cwd: updatedRoot,
        stdio: 'inherit',
      }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      [path.join(updatedRoot, 'scripts', 'postinstall-container.mjs')],
      { stdio: 'inherit' },
    );
  });
});
