import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import YAML from 'yaml';

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const originalCwd = process.cwd();
let tmpDir = '';
let workspacePath = '';

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writePolicy(raw: string): void {
  const policyPath = path.join(workspacePath, '.hybridclaw', 'policy.yaml');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, `${raw.trim()}\n`, 'utf-8');
}

function readPolicy(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      'utf-8',
    ),
  ) as Record<string, unknown>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-policy-remote-'));
  workspacePath = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  process.chdir(workspacePath);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
  workspacePath = '';
});

describe('remote policy authority', () => {
  test('applies signed-authority policy operations with revision tracking', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const remote = await import('../src/policy/remote-policy-authority.ts');

    initDatabase({ quiet: true });
    writePolicy(`
remote_updates:
  mode: apply
network:
  default: deny
  rules: []
  presets: []
`);

    const result = remote.handleRemotePolicyUpdate({
      workspacePath,
      principal: {
        peerId: 'platform',
        senderAgentId: 'security@hybridai@platform',
        policyAuthority: 'platform',
        capabilities: ['policy_write'],
      },
      content: JSON.stringify({
        update_id: 'cve-denylist-1',
        reason: 'CVE-class denylist update',
        operations: [
          {
            kind: 'pinned_red.add',
            pattern: 'curl\\s+https://bad.example/install.sh\\s*\\|\\s*sh',
          },
          { kind: 'allowlist.add', host: 'api.github.com', port: 443 },
          {
            kind: 'autonomy.tool.set',
            tool: 'bash',
            level: 'confirm-each',
          },
          {
            kind: 'full_auto.never_approve.add',
            value: 'bash:curl-pipe-shell',
          },
        ],
      }),
    });

    expect(result).toMatchObject({
      disposition: 'applied',
      updateId: 'cve-denylist-1',
      revisionChanged: true,
    });
    expect(result.diff).toEqual(
      expect.arrayContaining([
        expect.stringContaining('pinned_red added'),
        expect.stringContaining('allowlist added'),
        'autonomy.tool added bash=confirm-each',
        'full_auto.never_approve added bash:curl-pipe-shell',
      ]),
    );

    const document = readPolicy();
    expect(document).toMatchObject({
      autonomy: { tools: { bash: 'confirm-each' } },
      full_auto: { never_approve: ['bash:curl-pipe-shell'] },
    });
    expect(
      (
        (document.network as { rules?: Array<{ host?: string }> }).rules || []
      ).map((rule) => rule.host),
    ).toContain('api.github.com');

    expect(remote.listPolicyRevisions(workspacePath)).toHaveLength(1);
    const audit = getRecentStructuredAuditForSession(
      'policy:update:cve-denylist-1',
      5,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'policy.updated',
          disposition: 'applied',
          updateId: 'cve-denylist-1',
        }),
      ]),
    );
  });

  test('rejects policy updates without policy_write and quarantines by default', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const remote = await import('../src/policy/remote-policy-authority.ts');
    const content = JSON.stringify({
      update_id: 'starter-pack-1',
      operations: [{ kind: 'allowlist.add', host: 'api.openai.com' }],
    });

    initDatabase({ quiet: true });

    const rejected = remote.handleRemotePolicyUpdate({
      workspacePath,
      principal: {
        peerId: 'peer',
        senderAgentId: 'helper@team@peer',
        capabilities: [],
      },
      content,
    });
    expect(rejected).toMatchObject({
      disposition: 'rejected',
      reason: 'sender lacks policy_write capability',
    });
    expect(
      fs.existsSync(path.join(workspacePath, '.hybridclaw', 'policy.yaml')),
    ).toBe(false);

    const noAuthority = remote.handleRemotePolicyUpdate({
      workspacePath,
      principal: {
        peerId: 'peer',
        senderAgentId: 'helper@team@peer',
        capabilities: ['policy_write'],
      },
      content,
    });
    expect(noAuthority).toMatchObject({
      disposition: 'rejected',
      reason: 'sender is not declared as a superior-rights policy authority',
    });
    expect(
      fs.existsSync(path.join(workspacePath, '.hybridclaw', 'policy.yaml')),
    ).toBe(false);

    const quarantined = remote.handleRemotePolicyUpdate({
      workspacePath,
      principal: {
        peerId: 'platform',
        senderAgentId: 'security@hybridai@platform',
        policyAuthority: 'platform',
        capabilities: ['policy_write'],
      },
      content,
    });
    expect(quarantined.disposition).toBe('quarantined');
    expect(remote.listPendingPolicyUpdates()).toHaveLength(1);

    const accepted = remote.acceptPendingPolicyUpdate(
      quarantined.pendingId || '',
      workspacePath,
    );
    expect(accepted.disposition).toBe('applied');
    expect(remote.listPendingPolicyUpdates()).toEqual([]);
    expect(
      (
        (readPolicy().network as { rules?: Array<{ host?: string }> }).rules ||
        []
      ).map((rule) => rule.host),
    ).toContain('api.openai.com');

    const revision = remote.listPolicyRevisions(workspacePath)[0];
    expect(revision).toBeDefined();
    remote.rollbackPolicyRevision(workspacePath, revision?.id || -1);
    expect(
      (
        (readPolicy().network as { rules?: Array<{ host?: string }> }).rules ||
        []
      ).map((rule) => rule.host),
    ).toEqual(['hybridclaw.io']);
  });

  test('rejects pipeline reorder operations outside the v1 update contract', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const remote = await import('../src/policy/remote-policy-authority.ts');

    initDatabase({ quiet: true });

    const rejected = remote.handleRemotePolicyUpdate({
      workspacePath,
      principal: {
        peerId: 'platform',
        senderAgentId: 'security@hybridai@platform',
        policyAuthority: 'platform',
        capabilities: ['policy_write'],
      },
      content: JSON.stringify({
        update_id: 'pipeline-reorder-1',
        operations: [
          {
            kind: 'pipeline.reorder',
            stage: 'pre_tool',
            before: 'approval',
          },
        ],
      }),
    });

    expect(rejected).toMatchObject({
      disposition: 'rejected',
      updateId: 'pipeline-reorder-1',
      statusCode: 400,
      reason: 'Unsupported policy update operation kind: pipeline.reorder.',
    });
    expect(rejected.diff).toEqual([]);
    expect(
      fs.existsSync(path.join(workspacePath, '.hybridclaw', 'policy.yaml')),
    ).toBe(false);
    expect(remote.listPendingPolicyUpdates()).toEqual([]);
  });

  test('keeps pending updates retryable when acceptance fails', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const remote = await import('../src/policy/remote-policy-authority.ts');

    initDatabase({ quiet: true });

    const quarantined = remote.handleRemotePolicyUpdate({
      workspacePath,
      principal: {
        peerId: 'platform',
        senderAgentId: 'security@hybridai@platform',
        policyAuthority: 'platform',
        capabilities: ['policy_write'],
      },
      content: JSON.stringify({
        update_id: 'retryable-pending-1',
        operations: [{ kind: 'allowlist.add', host: 'retry.example.com' }],
      }),
    });
    expect(quarantined.disposition).toBe('quarantined');
    const pendingId = quarantined.pendingId || '';

    const blockedWorkspacePath = path.join(tmpDir, 'blocked-workspace');
    fs.writeFileSync(blockedWorkspacePath, 'not a directory', 'utf-8');
    const rejected = remote.acceptPendingPolicyUpdate(
      pendingId,
      blockedWorkspacePath,
    );

    expect(rejected).toMatchObject({
      disposition: 'rejected',
      pendingId,
    });
    expect(
      remote.listPendingPolicyUpdates().map((entry) => entry.pendingId),
    ).toEqual([pendingId]);
  });

  test('routes policy.update webhook envelopes through the signed A2A ingress', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const inbound = await import('../src/a2a/webhook-inbound.ts');
    const outbound = await import('../src/a2a/webhook-outbound.ts');
    const ipc = await import('../src/infra/ipc.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_INBOUND_WEBHOOK_SECRET: 'shared' });
    workspacePath = ipc.agentWorkspaceDir('main');
    fs.mkdirSync(workspacePath, { recursive: true });
    const serverCwd = path.join(tmpDir, 'server-cwd');
    fs.mkdirSync(serverCwd, { recursive: true });
    process.chdir(serverCwd);
    writePolicy(`
remote_updates:
  mode: apply
network:
  default: deny
  rules: []
  presets: []
`);

    inbound.upsertA2AWebhookInboundPeer({
      peerId: 'platform',
      senderAgentId: 'security@hybridai@platform',
      policyAuthority: 'platform',
      capabilities: ['policy_write'],
      secretRef: { source: 'store', id: 'A2A_INBOUND_WEBHOOK_SECRET' },
    });

    const rawBody = JSON.stringify({
      id: 'policy-msg-1',
      sender_agent_id: 'security@hybridai@platform',
      recipient_agent_id: 'main',
      thread_id: 'policy-thread',
      intent: 'policy.update',
      content: JSON.stringify({
        update_id: 'baseline-1',
        operations: [{ kind: 'allowlist.add', host: 'docs.hybridclaw.io' }],
      }),
      created_at: '2026-05-01T10:00:00.000Z',
      version: '1',
    });
    const nowMs = Date.parse('2030-05-03T00:00:00.000Z');

    const result = inbound.acceptA2AWebhookInboundEnvelope({
      peerId: 'platform',
      rawBody,
      signatureHeader: outbound.signWebhookBody({
        body: rawBody,
        secret: 'shared',
        timestampSeconds: Math.trunc(nowMs / 1000),
      }),
      nowMs,
    });

    expect(result).toMatchObject({
      statusCode: 202,
      body: {
        disposition: 'applied',
        updateId: 'baseline-1',
      },
    });
    expect(
      (
        (readPolicy().network as { rules?: Array<{ host?: string }> }).rules ||
        []
      ).map((rule) => rule.host),
    ).toContain('docs.hybridclaw.io');
    expect(
      fs.existsSync(path.join(serverCwd, '.hybridclaw', 'policy.yaml')),
    ).toBe(false);

    const invalidBody = JSON.stringify({
      id: 'policy-msg-invalid',
      sender_agent_id: 'security@hybridai@platform',
      recipient_agent_id: 'main',
      thread_id: 'policy-thread',
      intent: 'policy.update',
      content: '{not-json',
      created_at: '2026-05-01T10:01:00.000Z',
      version: '1',
    });

    const invalid = inbound.acceptA2AWebhookInboundEnvelope({
      peerId: 'platform',
      rawBody: invalidBody,
      signatureHeader: outbound.signWebhookBody({
        body: invalidBody,
        secret: 'shared',
        timestampSeconds: Math.trunc(nowMs / 1000),
      }),
      nowMs,
    });
    expect(invalid).toMatchObject({
      statusCode: 400,
      body: {
        disposition: 'rejected',
        reason: 'Policy update rejected',
      },
    });
  });

  test('fails fast when policy.update reaches the inbound pipeline without a workspace', async () => {
    const inboundPipeline = await import('../src/a2a/inbound-pipeline.ts');

    expect(() =>
      inboundPipeline.acceptA2AInboundEnvelope(
        {
          id: 'policy-msg-no-workspace',
          sender_agent_id: 'security@hybridai@platform',
          recipient_agent_id: 'main',
          thread_id: 'policy-thread',
          intent: 'policy.update',
          content: JSON.stringify({
            operations: [{ kind: 'allowlist.add', host: 'docs.hybridclaw.io' }],
          }),
          created_at: '2026-05-01T10:01:00.000Z',
          version: '1',
        },
        {
          source: 'webhook',
          actor: 'platform',
          policyUpdatePrincipal: {
            peerId: 'platform',
            senderAgentId: 'security@hybridai@platform',
            policyAuthority: 'platform',
            capabilities: ['policy_write'],
          },
        },
      ),
    ).toThrow('policy.update requires workspacePath');
  });
});
