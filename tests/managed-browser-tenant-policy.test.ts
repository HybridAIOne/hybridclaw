import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  readLocalManagedBrowserTenantPolicy,
  updateLocalManagedBrowserTenantAllowedHosts,
} from '../src/browser/managed-browser-tenant-policy.js';

const tempRoots: string[] = [];

function makeInstallRoot(policy: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-browser-policy-'));
  tempRoots.push(root);
  const policyDir = path.join(root, 'infra', 'managed-browser');
  fs.mkdirSync(policyDir, { recursive: true });
  fs.writeFileSync(path.join(policyDir, 'tenants.example.yaml'), policy);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('managed browser tenant policy admin helpers', () => {
  test('reads and updates broad HTTPS allow hosts for one tenant', () => {
    const root = makeInstallRoot(`tenants:
  tenant-a:
    network:
      default: deny
      rules:
        - action: allow
          host: example.com
          port: 443
          methods: ["*"]
          paths: ["/**"]
          agent: "*"
        - action: allow
          host: internal.example
          port: 443
          methods: ["GET"]
          paths: ["/docs/**"]
          agent: "*"
  tenant-b:
    network:
      default: deny
      rules:
        - action: allow
          host: tenant-b.example
          port: 443
          methods: ["*"]
          paths: ["/**"]
          agent: "*"
`);
    const dataDir = path.join(root, 'data');

    expect(
      readLocalManagedBrowserTenantPolicy({
        dataDir,
        installRoot: root,
        tenantId: 'tenant-a',
      }).allowedHosts,
    ).toEqual(['example.com']);

    const updated = updateLocalManagedBrowserTenantAllowedHosts({
      dataDir,
      installRoot: root,
      tenantId: 'tenant-a',
      allowedHosts: ['https://HybridClaw.io/docs', 'www.hybridclaw.io'],
    });

    expect(updated.allowedHosts).toEqual([
      'hybridclaw.io',
      'www.hybridclaw.io',
    ]);
    const raw = fs.readFileSync(
      path.join(dataDir, 'managed-browser', 'tenants.yaml'),
      'utf-8',
    );
    expect(raw).toContain('host: internal.example');
    expect(raw).toContain('host: tenant-b.example');
    expect(raw).toContain('host: hybridclaw.io');
    expect(raw).not.toContain('host: example.com');
  });
});
