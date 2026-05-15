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
  fs.writeFileSync(path.join(poolRoot, 'server.js'), '', 'utf-8');
  fs.writeFileSync(path.join(poolRoot, 'tenants.example.yaml'), '', 'utf-8');
  return root;
}

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

test('buildManagedBrowserPoolLaunchSpec launches the fixed local pool server', () => {
  const installRoot = makeInstallRoot();
  const dataDir = path.join(tempRoot, 'data');

  const spec = buildManagedBrowserPoolLaunchSpec(
    {
      endpointUrl: 'http://127.0.0.1:8787',
      defaultTenantId: '',
      pricing: {},
    },
    { dataDir, installRoot },
  );

  expect(spec.command).toBe(process.execPath);
  expect(spec.args).toEqual([
    path.join(installRoot, 'infra', 'managed-browser', 'server.js'),
  ]);
  expect(spec.cwd).toBe(path.join(installRoot, 'infra', 'managed-browser'));
  expect(spec.env.MANAGED_BROWSER_BIND_HOST).toBe('127.0.0.1');
  expect(spec.env.MANAGED_BROWSER_PORT).toBe('8787');
  expect(spec.env.MANAGED_BROWSER_STATE_PATH).toBe(
    path.join(dataDir, 'managed-browser', 'leases.json'),
  );
  expect(spec.env.MANAGED_BROWSER_AUDIT_PATH).toBe(
    path.join(dataDir, 'managed-browser', 'audit.jsonl'),
  );
});

test('buildManagedBrowserPoolLaunchSpec rejects remote endpoints', () => {
  expect(() =>
    buildManagedBrowserPoolLaunchSpec(
      {
        endpointUrl: 'https://browser.example',
        defaultTenantId: '',
        pricing: {},
      },
      { installRoot: makeInstallRoot() },
    ),
  ).toThrow(/loopback endpoints/u);
});
