import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-container-'));
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writeTrackedFiles(cwd: string): void {
  writePackagedTrackedFiles(cwd);
  fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ./.git/worktrees/dev\n');
}

function writePackagedTrackedFiles(cwd: string): void {
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'hybridclaw', version: '0.4.1' }),
  );
  fs.mkdirSync(path.join(cwd, 'container', 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'container', 'Dockerfile'), 'FROM scratch\n');
  fs.writeFileSync(
    path.join(cwd, 'container', 'package.json'),
    JSON.stringify({ name: 'hybridclaw-container', version: '0.4.1' }),
  );
  fs.writeFileSync(
    path.join(cwd, 'container', 'package-lock.json'),
    JSON.stringify({ name: 'hybridclaw-container', version: '0.4.1' }),
  );
  fs.writeFileSync(
    path.join(cwd, 'container', 'tsconfig.json'),
    JSON.stringify({ compilerOptions: {} }),
  );
  fs.writeFileSync(
    path.join(cwd, 'container', 'src', 'index.ts'),
    'export const ok = true;\n',
  );
}

function writeState(
  homeDir: string,
  cwd: string,
  imageName: string,
  fingerprint: string,
): void {
  const scopeKey = createHash('sha256')
    .update(path.resolve(cwd))
    .digest('hex')
    .slice(0, 16);
  const stateDir = path.join(
    homeDir,
    '.hybridclaw',
    'container-image-state',
    scopeKey,
  );
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'container-image-state.json'),
    `${JSON.stringify({
      imageName,
      fingerprint,
      recordedAt: new Date().toISOString(),
    })}\n`,
  );
}

function makeSpawnResult(result: {
  code?: number | null;
  err?: string;
  error?: Error;
}) {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
  };
  proc.stderr = new EventEmitter();

  queueMicrotask(() => {
    if (result.err) {
      proc.stderr.emit('data', Buffer.from(result.err));
    }
    if (result.error) {
      proc.emit('error', result.error);
      return;
    }
    proc.emit('close', result.code ?? 0);
  });

  return proc;
}

function isDockerInfoCommand(command: string, args: string[]): boolean {
  return command === 'docker' && args[0] === 'info';
}

function mockDockerAvailable(command: string, args: string[]) {
  if (isDockerInfoCommand(command, args)) {
    return makeSpawnResult({ code: 0 });
  }
  return null;
}

async function importFreshContainerSetup(options?: {
  homeDir?: string;
  spawnMock?: ReturnType<typeof vi.fn>;
  imageName?: string;
}) {
  vi.resetModules();
  process.env.HOME = options?.homeDir || createTempDir();
  vi.doMock('../src/config/config.ts', () => ({
    APP_VERSION: '0.4.1',
    CONTAINER_IMAGE: options?.imageName || 'hybridclaw-agent',
  }));
  if (options?.spawnMock) {
    vi.doMock('node:child_process', () => ({
      spawn: options.spawnMock,
    }));
  }
  return import('../src/infra/container-setup.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
  vi.doUnmock('../src/config/config.ts');
  vi.resetModules();
  vi.unstubAllEnvs();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: ORIGINAL_STDIN_IS_TTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: ORIGINAL_STDOUT_IS_TTY,
    configurable: true,
  });
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveContainerImageAcquisitionMode', () => {
  test('prefers local builds for the default image in a git checkout', async () => {
    const cwd = createTempDir();
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ./.git/worktrees/dev\n');
    const containerSetup = await importFreshContainerSetup();

    expect(
      containerSetup.resolveContainerImageAcquisitionMode(
        cwd,
        'hybridclaw-agent',
      ),
    ).toBe('build-only');
  });

  test('allows pull fallback for packaged installs without git metadata', async () => {
    const cwd = createTempDir();
    const containerSetup = await importFreshContainerSetup();

    expect(
      containerSetup.resolveContainerImageAcquisitionMode(
        cwd,
        'hybridclaw-agent',
      ),
    ).toBe('pull-only');
  });

  test('treats explicit remote image names as pull-first', async () => {
    const cwd = createTempDir();
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ./.git/worktrees/dev\n');
    const containerSetup = await importFreshContainerSetup();

    expect(
      containerSetup.resolveContainerImageAcquisitionMode(
        cwd,
        'ghcr.io/hybridaione/hybridclaw-agent:latest',
      ),
    ).toBe('pull-or-build');
  });

  test('respects HYBRIDCLAW_CONTAINER_PULL_IMAGE override', async () => {
    const cwd = createTempDir();
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ./.git/worktrees/dev\n');
    vi.stubEnv(
      'HYBRIDCLAW_CONTAINER_PULL_IMAGE',
      'ghcr.io/hybridaione/hybridclaw-agent:latest',
    );
    const containerSetup = await importFreshContainerSetup();

    expect(
      containerSetup.resolveContainerImageAcquisitionMode(
        cwd,
        'hybridclaw-agent',
      ),
    ).toBe('pull-or-build');
  });

  test('pulls custom image tags in packaged installs', async () => {
    const cwd = createTempDir();
    const containerSetup = await importFreshContainerSetup();

    expect(
      containerSetup.resolveContainerImageAcquisitionMode(
        cwd,
        'custom-hybridclaw',
      ),
    ).toBe('pull-only');
  });
});

describe('ensureContainerImageReady', () => {
  test('keeps using an existing image when stale rebuild fails', async () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    writeTrackedFiles(cwd);
    writeState(homeDir, cwd, 'hybridclaw-agent', 'stale-fingerprint');
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const spawnMock = vi.fn((command: string, args: string[]) => {
      const dockerAvailable = mockDockerAvailable(command, args);
      if (dockerAvailable) return dockerAvailable;
      if (
        command === 'docker' &&
        args[0] === 'image' &&
        args[1] === 'inspect'
      ) {
        return makeSpawnResult({ code: 0 });
      }
      if (
        command === 'npm' &&
        args[0] === 'run' &&
        args[1] === 'build:container'
      ) {
        return makeSpawnResult({ code: 1, err: 'build failed' });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const containerSetup = await importFreshContainerSetup({
      homeDir,
      spawnMock,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw gateway restart',
        cwd,
      }),
    ).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      "hybridclaw gateway restart: Unable to refresh image automatically. Continuing with existing container image 'hybridclaw-agent'.",
    );
    expect(warnSpy).toHaveBeenCalledWith('Details: build failed');
  });

  test('throws when the required image is missing and build fails', async () => {
    const cwd = createTempDir();
    writeTrackedFiles(cwd);
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const spawnMock = vi.fn((command: string, args: string[]) => {
      const dockerAvailable = mockDockerAvailable(command, args);
      if (dockerAvailable) return dockerAvailable;
      if (
        command === 'docker' &&
        args[0] === 'image' &&
        args[1] === 'inspect'
      ) {
        return makeSpawnResult({ code: 1, err: 'missing image' });
      }
      if (
        command === 'npm' &&
        args[0] === 'run' &&
        args[1] === 'build:container'
      ) {
        return makeSpawnResult({ code: 1, err: 'build failed' });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
    });

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw gateway restart',
        cwd,
      }),
    ).rejects.toThrow(
      "hybridclaw gateway restart: Required container image 'hybridclaw-agent' not found.",
    );
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  test('does not fall back to local build for packaged installs when pulls fail', async () => {
    const cwd = createTempDir();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const spawnMock = vi.fn((command: string, args: string[]) => {
      const dockerAvailable = mockDockerAvailable(command, args);
      if (dockerAvailable) return dockerAvailable;
      if (
        command === 'docker' &&
        args[0] === 'image' &&
        args[1] === 'inspect'
      ) {
        return makeSpawnResult({ code: 1, err: 'missing image' });
      }
      if (command === 'docker' && args[0] === 'pull') {
        return makeSpawnResult({ code: 1, err: 'pull failed' });
      }
      if (
        command === 'npm' &&
        args[0] === 'run' &&
        args[1] === 'build:container'
      ) {
        return makeSpawnResult({ code: 0 });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
    });

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw gateway restart',
        cwd,
      }),
    ).rejects.toThrow(
      "hybridclaw gateway restart: Required container image 'hybridclaw-agent' not found.",
    );
    expect(
      spawnMock.mock.calls.some(
        ([command, args]) =>
          command === 'npm' &&
          Array.isArray(args) &&
          args[0] === 'run' &&
          args[1] === 'build:container',
      ),
    ).toBe(false);
  });

  test('refreshes stale packaged installs by pulling instead of building locally', async () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    writePackagedTrackedFiles(cwd);
    writeState(homeDir, cwd, 'hybridclaw-agent', 'stale-fingerprint');
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const spawnMock = vi.fn((command: string, args: string[]) => {
      const dockerAvailable = mockDockerAvailable(command, args);
      if (dockerAvailable) return dockerAvailable;
      if (
        command === 'docker' &&
        args[0] === 'image' &&
        args[1] === 'inspect'
      ) {
        return makeSpawnResult({ code: 0 });
      }
      if (
        command === 'docker' &&
        args[0] === 'pull' &&
        args[1] === 'ghcr.io/hybridaione/hybridclaw-agent:v0.4.1'
      ) {
        return makeSpawnResult({ code: 0 });
      }
      if (
        command === 'docker' &&
        args[0] === 'tag' &&
        args[1] === 'ghcr.io/hybridaione/hybridclaw-agent:v0.4.1' &&
        args[2] === 'hybridclaw-agent'
      ) {
        return makeSpawnResult({ code: 0 });
      }
      if (
        command === 'npm' &&
        args[0] === 'run' &&
        args[1] === 'build:container'
      ) {
        throw new Error('packaged refresh should not build locally');
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const containerSetup = await importFreshContainerSetup({
      homeDir,
      spawnMock,
    });

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw gateway restart',
        cwd,
      }),
    ).resolves.toBeUndefined();
    expect(
      spawnMock.mock.calls.some(
        ([command, args]) =>
          command === 'docker' &&
          Array.isArray(args) &&
          args[0] === 'pull' &&
          args[1] === 'ghcr.io/hybridaione/hybridclaw-agent:v0.4.1',
      ),
    ).toBe(true);
    expect(
      spawnMock.mock.calls.some(
        ([command, args]) =>
          command === 'npm' &&
          Array.isArray(args) &&
          args[0] === 'run' &&
          args[1] === 'build:container',
      ),
    ).toBe(false);
  });

  test('fails explicitly when a packaged install is configured with a non-pullable image name', async () => {
    const cwd = createTempDir();
    writePackagedTrackedFiles(cwd);
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const spawnMock = vi.fn((command: string, args: string[]) => {
      const dockerAvailable = mockDockerAvailable(command, args);
      if (dockerAvailable) return dockerAvailable;
      if (
        command === 'docker' &&
        args[0] === 'image' &&
        args[1] === 'inspect'
      ) {
        return makeSpawnResult({ code: 1, err: 'missing image' });
      }
      if (
        command === 'npm' &&
        args[0] === 'run' &&
        args[1] === 'build:container'
      ) {
        throw new Error('packaged installs must not build locally');
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
      imageName: 'custom-hybridclaw',
    });

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw gateway restart',
        cwd,
      }),
    ).rejects.toThrow(
      "hybridclaw gateway restart: Required container image 'custom-hybridclaw' not found. Packaged installs only support pulling published runtime images automatically. Set `container.image` to a registry-qualified image name or set `HYBRIDCLAW_CONTAINER_PULL_IMAGE`. Details: No pullable container image source is configured for 'custom-hybridclaw'. Packaged installs only support pulling published runtime images. Set `container.image` to a registry-qualified image name or set `HYBRIDCLAW_CONTAINER_PULL_IMAGE`.",
    );
    expect(
      spawnMock.mock.calls.some(
        ([command, args]) =>
          command === 'npm' &&
          Array.isArray(args) &&
          args[0] === 'run' &&
          args[1] === 'build:container',
      ),
    ).toBe(false);
  });

  test('warns once and returns early when docker is missing for optional setup', async () => {
    const cwd = createTempDir();
    const spawnMock = vi.fn((command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'info') {
        return makeSpawnResult({
          error: Object.assign(new Error('spawn docker ENOENT'), {
            code: 'ENOENT',
          }),
        });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw onboarding',
        cwd,
        required: false,
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'hybridclaw onboarding: Install docker to use sandbox. Or start with --sandbox host.',
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('fails fast when docker is missing for required setup', async () => {
    const cwd = createTempDir();
    const spawnMock = vi.fn((command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'info') {
        return makeSpawnResult({
          error: Object.assign(new Error('spawn docker ENOENT'), {
            code: 'ENOENT',
          }),
        });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
    });

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw gateway restart',
        cwd,
      }),
    ).rejects.toThrow(
      'hybridclaw gateway restart: Install docker to use sandbox. Or start with --sandbox host.',
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('fails fast with a permission-specific error when docker daemon access is denied', async () => {
    const cwd = createTempDir();
    const spawnMock = vi.fn((command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'info') {
        return makeSpawnResult({ code: 1, err: 'permission denied' });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
    });

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw gateway restart',
        cwd,
      }),
    ).rejects.toThrow(
      'hybridclaw gateway restart: Docker is installed but the current user cannot access the Docker daemon (permission denied).',
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('normalizes docker info permission-denied stderr to the actionable detail', async () => {
    const cwd = createTempDir();
    const spawnMock = vi.fn((command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'info') {
        return makeSpawnResult({
          code: 1,
          err: [
            'ERROR: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/info": dial unix /var/run/docker.sock: connect: permission denied',
            'errors pretty printing info',
          ].join('\n'),
        });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
    });

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw gateway restart',
        cwd,
      }),
    ).rejects.toThrow(
      'hybridclaw gateway restart: Docker is installed but the current user cannot access the Docker daemon (permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/info": dial unix /var/run/docker.sock: connect: permission denied).',
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
