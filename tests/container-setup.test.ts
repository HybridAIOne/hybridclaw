import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;

const createTempDir = useTempDir('hybridclaw-container-');

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
  out?: string;
  err?: string;
  error?: Error;
}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  queueMicrotask(() => {
    if (result.out) {
      proc.stdout.emit('data', Buffer.from(result.out));
    }
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

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    restoreEnvVar('HOME', ORIGINAL_HOME);
    Object.defineProperty(process.stdin, 'isTTY', {
      value: ORIGINAL_STDIN_IS_TTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: ORIGINAL_STDOUT_IS_TTY,
      configurable: true,
    });
  },
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['node:child_process', '../src/config/config.ts'],
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

describe('resolveContainerImageVersion', () => {
  test('prefers the OCI image version label when present', async () => {
    const spawnMock = vi.fn((command: string, args: string[]) => {
      if (
        command === 'docker' &&
        args[0] === 'image' &&
        args[1] === 'inspect' &&
        args[2] === 'hybridclaw-agent'
      ) {
        return makeSpawnResult({
          code: 0,
          out: JSON.stringify([
            {
              RepoTags: ['hybridclaw-agent:latest'],
              Config: {
                Labels: {
                  'org.opencontainers.image.version': '0.4.1',
                },
              },
            },
          ]),
        });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });
    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
    });

    await expect(
      containerSetup.resolveContainerImageVersion('hybridclaw-agent'),
    ).resolves.toBe('0.4.1');
  });

  test('falls back to a version-like repo tag when labels are missing', async () => {
    const spawnMock = vi.fn((command: string, args: string[]) => {
      if (
        command === 'docker' &&
        args[0] === 'image' &&
        args[1] === 'inspect' &&
        args[2] === 'hybridclaw-agent'
      ) {
        return makeSpawnResult({
          code: 0,
          out: JSON.stringify([
            {
              RepoTags: [
                'hybridclaw-agent:latest',
                'ghcr.io/hybridaione/hybridclaw-agent:v0.4.1',
              ],
              Config: {
                Labels: {},
              },
            },
          ]),
        });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });
    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
    });

    await expect(
      containerSetup.resolveContainerImageVersion('hybridclaw-agent'),
    ).resolves.toBe('0.4.1');
  });

  test('falls back to the configured image tag when inspect is unavailable', async () => {
    const taggedImage = 'ghcr.io/example/hybridclaw-agent:v0.4.1';
    const spawnMock = vi.fn((command: string, args: string[]) => {
      if (
        command === 'docker' &&
        args[0] === 'image' &&
        args[1] === 'inspect' &&
        args[2] === taggedImage
      ) {
        return makeSpawnResult({ code: 1, err: 'missing image' });
      }
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });
    const containerSetup = await importFreshContainerSetup({
      homeDir: createTempDir(),
      spawnMock,
    });

    await expect(
      containerSetup.resolveContainerImageVersion(taggedImage),
    ).resolves.toBe('0.4.1');
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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
    expect(logSpy).toHaveBeenCalledWith(
      "hybridclaw gateway restart: Container sources changed since the last recorded build. Building container image 'hybridclaw-agent'...",
    );
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

  test('does not repeat the refresh reason when pull-or-build falls back to a local build', async () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    writeTrackedFiles(cwd);
    writeState(homeDir, cwd, 'hybridclaw-agent', 'stale-fingerprint');
    vi.stubEnv(
      'HYBRIDCLAW_CONTAINER_PULL_IMAGE',
      'ghcr.io/hybridaione/hybridclaw-agent:latest',
    );
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
        args[1] === 'ghcr.io/hybridaione/hybridclaw-agent:latest'
      ) {
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
      homeDir,
      spawnMock,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      containerSetup.ensureContainerImageReady({
        commandName: 'hybridclaw gateway restart',
        cwd,
      }),
    ).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith(
      'hybridclaw gateway restart: Container sources changed since the last recorded build.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      "hybridclaw gateway restart: Pulling container image 'ghcr.io/hybridaione/hybridclaw-agent:latest'...",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "hybridclaw gateway restart: Building container image 'hybridclaw-agent'...",
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      "hybridclaw gateway restart: Container sources changed since the last recorded build. Building container image 'hybridclaw-agent'...",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "hybridclaw gateway restart: Unable to pull image 'ghcr.io/hybridaione/hybridclaw-agent:latest'.",
    );
    expect(warnSpy).toHaveBeenCalledWith('Details: pull failed');
  });

  test('refreshes stale packaged installs by pulling from Docker Hub before building locally', async () => {
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
        args[1] === 'hybridaione/hybridclaw-agent:v0.4.1'
      ) {
        return makeSpawnResult({ code: 0 });
      }
      if (
        command === 'docker' &&
        args[0] === 'tag' &&
        args[1] === 'hybridaione/hybridclaw-agent:v0.4.1' &&
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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
          args[1] === 'hybridaione/hybridclaw-agent:v0.4.1',
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
    expect(logSpy).toHaveBeenCalledWith(
      'hybridclaw gateway restart: A newer published container image may be available for this install.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      "hybridclaw gateway restart: Pulling container image 'hybridaione/hybridclaw-agent:v0.4.1'...",
    );
  });

  test('falls back to GHCR only after Docker Hub pull attempts fail for packaged installs', async () => {
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
        args[1] === 'hybridaione/hybridclaw-agent:v0.4.1'
      ) {
        return makeSpawnResult({
          code: 1,
          err: 'dockerhub version pull failed',
        });
      }
      if (
        command === 'docker' &&
        args[0] === 'pull' &&
        args[1] === 'hybridaione/hybridclaw-agent:latest'
      ) {
        return makeSpawnResult({
          code: 1,
          err: 'dockerhub latest pull failed',
        });
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
      spawnMock.mock.calls
        .filter(
          ([command, args]) =>
            command === 'docker' && Array.isArray(args) && args[0] === 'pull',
        )
        .map(([, args]) => args[1]),
    ).toEqual([
      'hybridaione/hybridclaw-agent:v0.4.1',
      'hybridaione/hybridclaw-agent:latest',
      'ghcr.io/hybridaione/hybridclaw-agent:v0.4.1',
    ]);
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
