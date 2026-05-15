import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import YAML from 'yaml';

import { syncLocalManagedBrowserTenantPolicyFromAdminPolicies } from '../src/browser/managed-browser-tenant-policy.js';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-browser-policy-'));
  tempRoots.push(root);
  return root;
}

function writeAgentPolicy(root: string, agentId: string, policy: string): void {
  const policyDir = path.join(root, 'workspaces', agentId, '.hybridclaw');
  fs.mkdirSync(policyDir, { recursive: true });
  fs.writeFileSync(path.join(policyDir, 'policy.yaml'), policy);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('managed browser tenant policy projection', () => {
  test('projects admin approval network policy into pool tenant policy', () => {
    const root = makeTempRoot();
    writeAgentPolicy(
      root,
      'main',
      `network:
  default: deny
  rules:
    - action: allow
      host: example.com
      port: 443
      methods: ["*"]
      paths: ["/**"]
      agent: "*"
`,
    );
    writeAgentPolicy(
      root,
      'writer',
      `network:
  default: deny
  rules:
    - action: allow
      host: docs.hybridclaw.io
      port: 443
      methods: ["GET"]
      paths: ["/docs/**"]
      agent: "*"
`,
    );

    const result = syncLocalManagedBrowserTenantPolicyFromAdminPolicies({
      dataDir: path.join(root, 'data'),
      tenantId: 'tenant-a',
      agentIds: ['main', 'writer'],
      resolveWorkspacePath: (agentId) => path.join(root, 'workspaces', agentId),
    });

    expect(result).toMatchObject({
      tenantId: 'tenant-a',
      agentIds: ['main', 'writer'],
      ruleCount: 2,
    });

    const projected = YAML.parse(
      fs.readFileSync(result.policyPath, 'utf-8'),
    ) as {
      tenants: Record<
        string,
        {
          network: {
            default: string;
            rules: Array<{ host: string; agent: string }>;
          };
        }
      >;
    };

    expect(projected.tenants['tenant-a'].network.default).toBe('deny');
    expect(projected.tenants['tenant-a'].network.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: 'example.com', agent: 'main' }),
        expect.objectContaining({
          host: 'docs.hybridclaw.io',
          agent: 'writer',
        }),
      ]),
    );
    expect(projected.tenants.main.network.rules).toEqual([
      expect.objectContaining({ host: 'example.com', agent: 'main' }),
    ]);
    expect(projected.tenants.writer.network.rules).toEqual([
      expect.objectContaining({
        host: 'docs.hybridclaw.io',
        agent: 'writer',
      }),
    ]);
  });
});
