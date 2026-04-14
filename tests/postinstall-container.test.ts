import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';
import {
  buildBootstrapEnv,
  inspectContainerBootstrap,
  resolveNpmCommand,
} from '../scripts/postinstall-container.mjs';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-postinstall-');

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

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
      '--workspaces=false',
    ],
  });
});

test('scrubs outer npm lifecycle variables before bootstrapping container deps', () => {
  expect(
    buildBootstrapEnv({
      npm_command: 'install',
      npm_config_cache: '/tmp/npm-cache',
      npm_config_global: 'true',
      npm_config_prefix: '/tmp/global-prefix',
      npm_execpath: '/tmp/npm-cli.js',
      npm_lifecycle_event: 'postinstall',
      npm_lifecycle_script: 'node ./scripts/postinstall-container.mjs',
      npm_package_name: '@hybridaione/hybridclaw',
      npm_package_version: '0.9.5',
      PATH: '/usr/bin',
    }),
  ).toEqual({
    PATH: '/usr/bin',
    npm_config_cache: '/tmp/npm-cache',
  });
});

test('runs bootstrap when executed as a direct node script', () => {
  const packageRoot = makeTempDir();
  const npmCliPath = path.join(packageRoot, 'fake-npm-cli.cjs');
  const scriptDir = path.join(packageRoot, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), 'scripts', 'postinstall-container.mjs'),
    path.join(scriptDir, 'postinstall-container.mjs'),
  );
  writeJson(path.join(packageRoot, 'container', 'package.json'), {
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.27.1',
    },
  });
  fs.writeFileSync(
    npmCliPath,
    `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.npm_config_global) process.exit(11);
const prefixIndex = args.indexOf('--prefix');
if (prefixIndex === -1 || !args[prefixIndex + 1]) process.exit(2);
const containerDir = args[prefixIndex + 1];
const packageJsonPath = path.join(
  containerDir,
  'node_modules',
  '@modelcontextprotocol',
  'sdk',
  'package.json',
);
fs.mkdirSync(path.dirname(packageJsonPath), { recursive: true });
fs.writeFileSync(
  packageJsonPath,
  JSON.stringify({ name: '@modelcontextprotocol/sdk', version: '1.27.1' }),
);
process.exit(0);
`,
    'utf-8',
  );

  const result = spawnSync(
    process.execPath,
    [path.join(scriptDir, 'postinstall-container.mjs')],
    {
      cwd: packageRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        npm_config_global: 'true',
        npm_lifecycle_event: 'postinstall',
        npm_lifecycle_script: 'node ./scripts/postinstall-container.mjs',
        npm_package_name: '@hybridaione/hybridclaw',
        npm_execpath: npmCliPath,
      },
    },
  );

  expect(result.status).toBe(0);
  expect(
    fs.existsSync(
      path.join(
        packageRoot,
        'container',
        'node_modules',
        '@modelcontextprotocol',
        'sdk',
        'package.json',
      ),
    ),
  ).toBe(true);
});
