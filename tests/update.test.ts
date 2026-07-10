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

const readlineState = vi.hoisted(() => ({ answer: 'n' }));
vi.mock('node:readline/promises', () => {
  const createInterface = () => ({
    question: async () => readlineState.answer,
    close: () => {},
  });
  return { default: { createInterface }, createInterface };
});

// The version cache lives under the runtime home dir, which is resolved from
// HYBRIDCLAW_DATA_DIR at module load. Point it at a throwaway dir before any
// dynamic import of update.js so cache reads/writes stay isolated.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-data-'));
process.env.HYBRIDCLAW_DATA_DIR = TEST_DATA_DIR;
const CACHE_FILE = path.join(TEST_DATA_DIR, 'version-check.json');

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
      [
        'install',
        '-g',
        '--ignore-scripts',
        '--omit=dev',
        '--no-fund',
        '--no-audit',
        '@hybridaione/hybridclaw@latest',
      ],
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

describe('maybePromptStartupUpdate', () => {
  const originalArgv = [...process.argv];
  const originalCwd = process.cwd();
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;
  let tempDir = '';

  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    readlineState.answer = 'n';
    fs.rmSync(CACHE_FILE, { force: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-startup-'));
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
    fs.rmSync(CACHE_FILE, { force: true });
    vi.restoreAllMocks();
  });

  function setTty(value: boolean) {
    Object.defineProperty(process.stdin, 'isTTY', {
      value,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value,
      configurable: true,
    });
  }

  function setupGlobalPackageInstall() {
    const globalNodeModules = path.join(tempDir, 'node_modules');
    const installRoot = path.join(
      globalNodeModules,
      '@hybridaione',
      'hybridclaw',
    );
    fs.mkdirSync(path.join(installRoot, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, 'package.json'),
      JSON.stringify({ name: '@hybridaione/hybridclaw', version: '0.9.8' }),
    );
    // chdir into tempDir (no package.json, no .git) so detectInstallContext
    // classifies the entry as a global `package`, not the repo source checkout.
    process.chdir(tempDir);
    process.argv = [
      originalArgv[0] || 'node',
      path.join(installRoot, 'dist', 'cli.js'),
    ];
    return { installRoot, globalNodeModules };
  }

  // The prompt confirms the entry point is the *global* install via `npm root
  // -g` before prompting. Point that lookup at the global node_modules holding
  // the install (matches) unless a test overrides it (project-local install).
  function mockNpmGlobalRoot(globalNodeModules: string) {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root' && args[1] === '-g') {
        return { status: 0, stdout: `${globalNodeModules}\n`, stderr: '' };
      }
      if (args[0] === '--version') {
        return { status: 0, stdout: '10.0.0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
  }

  function writeCache(latestVersion: string, ageMs = 0) {
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({
        latestVersion,
        lastCheckedAt: new Date(Date.now() - ageMs).toISOString(),
      }),
    );
  }

  it('does nothing in a non-interactive terminal', async () => {
    setTty(false);
    setupGlobalPackageInstall();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    await maybePromptStartupUpdate('0.9.8');

    expect(spawnMock).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does not prompt or refresh from a source checkout', async () => {
    setTty(true);
    fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: '@hybridaione/hybridclaw', version: '0.9.8' }),
    );
    process.chdir(tempDir);
    process.argv = [
      originalArgv[0] || 'node',
      path.join(tempDir, 'dist', 'cli.js'),
    ];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    await maybePromptStartupUpdate('0.9.8');

    expect(spawnMock).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('spawns a detached background refresh when no cache exists, without prompting', async () => {
    setTty(true);
    setupGlobalPackageInstall();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    await maybePromptStartupUpdate('0.9.8');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toContain('__refresh-version-cache');
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('spawns a refresh when the cache is stale', async () => {
    setTty(true);
    setupGlobalPackageInstall();
    writeCache('0.9.8', 21 * 60 * 60 * 1000); // older than the 20h TTL

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    await maybePromptStartupUpdate('0.9.8');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).toContain('__refresh-version-cache');
  });

  it('does not refresh when the cache is fresh', async () => {
    setTty(true);
    setupGlobalPackageInstall();
    writeCache('0.9.8', 60 * 1000); // 1 minute old

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    await maybePromptStartupUpdate('0.9.8');

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stays silent when the cached latest matches the current version', async () => {
    setTty(true);
    setupGlobalPackageInstall();
    writeCache('0.9.8', 60 * 1000);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    await maybePromptStartupUpdate('0.9.8');

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prompts from a fresh cache with a newer version and skips when declined', async () => {
    setTty(true);
    const { globalNodeModules } = setupGlobalPackageInstall();
    writeCache('0.42.0', 60 * 1000);
    readlineState.answer = 'n';
    mockNpmGlobalRoot(globalNodeModules);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    const updated = await maybePromptStartupUpdate('0.9.8');

    expect(updated).toBe(false);
    const messages = logSpy.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain('Update available: 0.9.8 -> 0.42.0');
    expect(messages.some((m) => m.startsWith('Skipping update'))).toBe(true);
    // Fresh cache means no refresh; declining means no install spawn.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('installs and reports updated=true when the user accepts', async () => {
    setTty(true);
    const { installRoot, globalNodeModules } = setupGlobalPackageInstall();
    writeCache('0.42.0', 60 * 1000);
    readlineState.answer = 'y';
    requestExternalGatewayRestartMock.mockReturnValue({
      status: 'not-running',
      pid: null,
      reason: null,
    });
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'view') {
        return { status: 0, stdout: '0.42.0\n', stderr: '' };
      }
      if (command === 'npm' && args[0] === '--version') {
        return { status: 0, stdout: '10.0.0\n', stderr: '' };
      }
      if (command === 'npm' && args[0] === 'root' && args[1] === '-g') {
        return { status: 0, stdout: `${globalNodeModules}\n`, stderr: '' };
      }
      if (command === 'npm' && args[0] === 'rebuild') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    spawnMock.mockImplementation(() => ({
      on(event: string, handler: (value?: number) => void) {
        if (event === 'close') handler(0);
      },
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    const updated = await maybePromptStartupUpdate('0.9.8');

    expect(updated).toBe(true);
    // Delegates to the full update command, which runs the global install.
    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      [
        'install',
        '-g',
        '--ignore-scripts',
        '--omit=dev',
        '--no-fund',
        '--no-audit',
        '@hybridaione/hybridclaw@latest',
      ],
      { stdio: 'inherit' },
    );
    expect(installRoot).toContain('@hybridaione');
  });

  it('resolves a global bin symlink to the real package before prompting', async () => {
    setTty(true);
    const { installRoot, globalNodeModules } = setupGlobalPackageInstall();
    // A global npm install exposes the CLI as a bin shim on PATH that symlinks
    // to the real dist entry. process.argv[1] is that shim, not the package
    // path, so detection must follow the link to find the package root.
    const realEntry = path.join(installRoot, 'dist', 'cli.js');
    fs.writeFileSync(realEntry, '');
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binShim = path.join(binDir, 'hybridclaw');
    fs.symlinkSync(realEntry, binShim);
    process.argv = [originalArgv[0] || 'node', binShim];
    writeCache('0.42.0', 60 * 1000);
    readlineState.answer = 'n';
    mockNpmGlobalRoot(globalNodeModules);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    const updated = await maybePromptStartupUpdate('0.9.8');

    expect(updated).toBe(false);
    const messages = logSpy.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain('Update available: 0.9.8 -> 0.42.0');
  });

  it('does not prompt for a project-local install whose global root differs', async () => {
    setTty(true);
    const { installRoot } = setupGlobalPackageInstall();
    writeCache('0.42.0', 60 * 1000);
    // The package manager's global root holds a *different* copy, so the
    // running entry point is a project-local dependency we must not upgrade
    // with a global install.
    const otherGlobalPkg = path.join(
      tempDir,
      'global',
      'node_modules',
      '@hybridaione',
      'hybridclaw',
    );
    fs.mkdirSync(otherGlobalPkg, { recursive: true });
    fs.writeFileSync(
      path.join(otherGlobalPkg, 'package.json'),
      JSON.stringify({ name: '@hybridaione/hybridclaw', version: '0.42.0' }),
    );
    expect(installRoot).not.toBe(otherGlobalPkg);
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root' && args[1] === '-g') {
        return {
          status: 0,
          stdout: `${path.dirname(path.dirname(otherGlobalPkg))}\n`,
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { maybePromptStartupUpdate } = await import('../src/update.js');
    const updated = await maybePromptStartupUpdate('0.9.8');

    expect(updated).toBe(false);
    // No prompt, no install: a local copy never triggers a global update.
    expect(logSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('refreshVersionCache', () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    spawnSyncMock.mockReset();
    fs.rmSync(CACHE_FILE, { force: true });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    fs.rmSync(CACHE_FILE, { force: true });
    vi.restoreAllMocks();
  });

  it('writes the latest version to the cache file', async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'view') {
        return { status: 0, stdout: '0.42.0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    const { refreshVersionCache } = await import('../src/update.js');
    refreshVersionCache();

    expect(fs.existsSync(CACHE_FILE)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as {
      latestVersion: string;
      lastCheckedAt: string;
    };
    expect(parsed.latestVersion).toBe('0.42.0');
    expect(Number.isNaN(Date.parse(parsed.lastCheckedAt))).toBe(false);
  });

  it('does not write a cache when the registry check fails', async () => {
    spawnSyncMock.mockImplementation(() => ({
      status: 1,
      stdout: '',
      stderr: 'network error',
    }));

    const { refreshVersionCache } = await import('../src/update.js');
    refreshVersionCache();

    expect(fs.existsSync(CACHE_FILE)).toBe(false);
  });
});

describe('printUpdateUsage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints usage with the documented options', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { printUpdateUsage } = await import('../src/update.js');
    printUpdateUsage();
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Usage: hybridclaw update');
    expect(output).toContain('--check');
    expect(output).toContain('--yes');
  });
});
