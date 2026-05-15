import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';
import { buildManagedBrowserPoolLaunchSpec } from '../src/browser/managed-browser-pool-launcher.js';

let tempRoot = '';

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-browser-launcher-'));
  return tempRoot;
}

function makeInstallRoot(): string {
  const root = makeTempRoot();
  const poolRoot = path.join(root, 'infra', 'managed-browser');
  fs.mkdirSync(poolRoot, { recursive: true });
  fs.writeFileSync(path.join(poolRoot, 'docker-compose.yml'), '', 'utf-8');
  return root;
}

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

test('buildManagedBrowserPoolLaunchSpec launches the fixed Docker Compose service', () => {
  const installRoot = makeInstallRoot();

  const spec = buildManagedBrowserPoolLaunchSpec(
    {
      endpointUrl: 'http://127.0.0.1:8787',
      defaultTenantId: '',
      pricing: {},
    },
    {
      installRoot,
      policyPath: path.join(installRoot, 'tenants.yaml'),
      poolToken: 'pool-token',
    },
  );

  expect(spec.command).toBe('docker');
  expect(spec.args).toEqual([
    'compose',
    '-f',
    path.join('infra', 'managed-browser', 'docker-compose.yml'),
    'up',
    '-d',
    '--build',
    'browser-pool',
  ]);
  expect(spec.cwd).toBe(installRoot);
  expect(spec.env.MANAGED_BROWSER_PUBLISH_HOST).toBe('127.0.0.1');
  expect(spec.env.MANAGED_BROWSER_PORT).toBe('8787');
  expect(spec.env.MANAGED_BROWSER_POLICY_HOST_PATH).toBe(
    path.join(installRoot, 'tenants.yaml'),
  );
  expect(spec.env.MANAGED_BROWSER_POOL_TOKEN).toBe('pool-token');
});

test('buildManagedBrowserPoolLaunchSpec requires a pool token for Docker Compose', () => {
  expect(() =>
    buildManagedBrowserPoolLaunchSpec(
      {
        endpointUrl: 'http://127.0.0.1:8787',
        defaultTenantId: '',
        pricing: {},
      },
      { installRoot: makeInstallRoot() },
    ),
  ).toThrow(/poolTokenRef/u);
});

test('buildManagedBrowserPoolLaunchSpec rejects remote endpoints', () => {
  expect(() =>
    buildManagedBrowserPoolLaunchSpec(
      {
        endpointUrl: 'https://browser.example',
        defaultTenantId: '',
        pricing: {},
      },
      { installRoot: makeInstallRoot(), poolToken: 'pool-token' },
    ),
  ).toThrow(/loopback endpoints/u);
});
