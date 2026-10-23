import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, expect, test, vi } from 'vitest';
import { getGatewayBuildDiagnostics } from '../src/gateway/gateway-build-diagnostics.js';
import { useTempDir } from './test-utils.js';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((_command: string, args: string[]) => ({
    status: 0,
    stdout: args.includes('--abbrev-ref') ? 'main\n' : 'abc123\n',
  }));
});

const makeTempDir = useTempDir('hybridclaw-build-diagnostics-');

const BUILD_TIME = new Date('2026-01-01T00:00:00.000Z');
const BEFORE_BUILD = new Date('2025-12-31T00:00:00.000Z');
const AFTER_BUILD = new Date('2026-01-02T00:00:00.000Z');

function writeFile(root: string, relativePath: string, mtime: Date): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
  fs.utimesSync(filePath, mtime, mtime);
}

function writeBuildOutputs(root: string): void {
  for (const buildPath of [
    'dist/cli.js',
    'dist/gateway/gateway-service.js',
    'dist/gateway/gateway-http-proxy.js',
    'container/dist/index.js',
    'container/shared/dist/network-policy.js',
  ]) {
    writeFile(root, buildPath, BUILD_TIME);
  }
}

function writeSourceCheckout(root: string, containerToolsMtime: Date): void {
  writeBuildOutputs(root);
  writeFile(root, 'src/cli.ts', BEFORE_BUILD);
  writeFile(root, 'src/gateway/gateway-service.ts', BEFORE_BUILD);
  writeFile(root, 'src/gateway/gateway-http-proxy.ts', BEFORE_BUILD);
  writeFile(root, 'container/src/tools.ts', containerToolsMtime);
  writeFile(root, 'container/shared/src/network-policy.ts', BEFORE_BUILD);
}

test('packaged install is not stale even when shipped container sources look newer', () => {
  const root = makeTempDir();
  writeBuildOutputs(root);
  writeFile(root, 'container/src/tools.ts', AFTER_BUILD);

  const build = getGatewayBuildDiagnostics(root);

  expect(build.staleBuild).toBe(false);
  expect(build.files).toEqual([]);
  expect(build.gitCommit).toBeNull();
  expect(build.gitBranch).toBeNull();
  expect(spawnSyncMock).not.toHaveBeenCalled();
});

test('source checkout edited after the build is stale', () => {
  const root = makeTempDir();
  writeSourceCheckout(root, AFTER_BUILD);

  const build = getGatewayBuildDiagnostics(root);

  expect(build.staleBuild).toBe(true);
  expect(build.files.map((file) => [file.name, file.status])).toEqual([
    ['cli', 'ok'],
    ['gateway-service', 'ok'],
    ['gateway-http-proxy', 'ok'],
    ['container-tools', 'source_newer'],
    ['container-shared', 'ok'],
  ]);
});

test('freshly built source checkout is not stale', () => {
  const root = makeTempDir();
  writeSourceCheckout(root, BEFORE_BUILD);

  const build = getGatewayBuildDiagnostics(root);

  expect(build.staleBuild).toBe(false);
  expect(build.files).toHaveLength(5);
  expect(build.files.every((file) => file.status === 'ok')).toBe(true);
  expect(build.gitCommit).toBe('abc123');
  expect(build.gitBranch).toBe('main');
});

test('source checkout with container/shared edited after the build is stale', () => {
  const root = makeTempDir();
  writeSourceCheckout(root, BEFORE_BUILD);
  writeFile(root, 'container/shared/src/network-policy.ts', AFTER_BUILD);

  const build = getGatewayBuildDiagnostics(root);

  expect(build.staleBuild).toBe(true);
  expect(
    build.files.find((file) => file.name === 'container-shared')?.status,
  ).toBe('source_newer');
});
