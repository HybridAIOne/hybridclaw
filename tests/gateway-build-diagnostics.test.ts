import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';
import { getGatewayBuildDiagnostics } from '../src/gateway/gateway-build-diagnostics.js';
import { useTempDir } from './test-utils.js';

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
    'container/dist/tools.js',
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
}

test('packaged install is not stale even when shipped container sources look newer', () => {
  const root = makeTempDir();
  writeBuildOutputs(root);
  writeFile(root, 'container/src/tools.ts', AFTER_BUILD);

  const build = getGatewayBuildDiagnostics(root);

  expect(build.staleBuild).toBe(false);
  expect(build.files).toEqual([]);
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
  ]);
});

test('freshly built source checkout is not stale', () => {
  const root = makeTempDir();
  writeSourceCheckout(root, BEFORE_BUILD);

  const build = getGatewayBuildDiagnostics(root);

  expect(build.staleBuild).toBe(false);
  expect(build.files).toHaveLength(4);
  expect(build.files.every((file) => file.status === 'ok')).toBe(true);
});
