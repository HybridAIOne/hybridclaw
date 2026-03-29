import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  inspectContainerBootstrap,
  resolveNpmCommand,
} from '../scripts/postinstall-container.mjs';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-postinstall-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips packaged container bootstrap in a source checkout', () => {
  const packageRoot = makeTempDir();
  fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
  writeJson(path.join(packageRoot, 'container', 'package.json'), {
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.27.1',
    },
  });

  expect(inspectContainerBootstrap(packageRoot)).toMatchObject({
    needed: false,
    reason: 'source-checkout',
  });
});

test('bootstraps packaged installs when container dependencies are missing', () => {
  const packageRoot = makeTempDir();
  writeJson(path.join(packageRoot, 'container', 'package.json'), {
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.27.1',
      playwright: '^1.58.2',
    },
  });

  expect(inspectContainerBootstrap(packageRoot)).toMatchObject({
    needed: true,
    reason: 'missing-dependencies',
    missingDependencies: ['@modelcontextprotocol/sdk', 'playwright'],
  });
});

test('skips packaged installs when container dependencies are already present', () => {
  const packageRoot = makeTempDir();
  const containerDir = path.join(packageRoot, 'container');
  writeJson(path.join(containerDir, 'package.json'), {
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.27.1',
    },
  });
  writeJson(
    path.join(
      containerDir,
      'node_modules',
      '@modelcontextprotocol',
      'sdk',
      'package.json',
    ),
    {
      name: '@modelcontextprotocol/sdk',
      version: '1.27.1',
    },
  );

  expect(inspectContainerBootstrap(packageRoot)).toMatchObject({
    needed: false,
    reason: 'dependencies-present',
  });
});

test('prefers npm_execpath when npm exposes it during install', () => {
  const packageRoot = makeTempDir();
  const npmCliPath = path.join(packageRoot, 'npm-cli.js');
  fs.writeFileSync(npmCliPath, '', 'utf-8');

  expect(
    resolveNpmCommand('/tmp/hybridclaw-container', {
      ...process.env,
      npm_execpath: npmCliPath,
    }),
  ).toEqual({
    command: process.execPath,
    args: [
      npmCliPath,
      '--prefix',
      '/tmp/hybridclaw-container',
      'install',
      '--omit=dev',
    ],
  });
});
