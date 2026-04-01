import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
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

  it('reminds the user to restart the gateway after a successful package update', async () => {
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
        version: '0.9.8',
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
        return {
          status: 0,
          stdout: '0.10.0\n',
          stderr: '',
        };
      }
      if (command === 'npm' && args[0] === '--version') {
        return {
          status: 0,
          stdout: '10.0.0\n',
          stderr: '',
        };
      }
      return {
        status: 1,
        stdout: '',
        stderr: '',
      };
    });

    spawnMock.mockImplementation(() => ({
      on(event: string, handler: (value?: number) => void) {
        if (event === 'close') {
          handler(0);
        }
      },
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runUpdateCommand } = await import('../src/update.js');
    await runUpdateCommand(['--yes'], '0.9.8');

    expect(logSpy).toHaveBeenCalledWith(
      'If the gateway is already running, restart it to load the new version:',
    );
    expect(logSpy).toHaveBeenCalledWith('  hybridclaw gateway restart');
    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@hybridaione/hybridclaw@latest'],
      { stdio: 'inherit' },
    );
  });
});
