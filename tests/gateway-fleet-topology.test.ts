import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_INSTANCE_ID = process.env.HYBRIDCLAW_INSTANCE_ID;

let tmpDir: string;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function peerPublicKeyJwk() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ format: 'jwk' });
}

function jsonFetch(body: unknown): typeof fetch {
  return vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-fleet-topology-'));
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  process.env.HYBRIDCLAW_INSTANCE_ID = 'hq-dev';
  vi.resetModules();
});

afterEach(() => {
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDCLAW_INSTANCE_ID', ORIGINAL_INSTANCE_ID);
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gateway admin fleet topology', () => {
  test('lists HQ and child instance status from the A2A trust ledger', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const service = await import('../src/gateway/gateway-fleet-topology.ts');

    initDatabase({ quiet: true });
    const topology = await service.upsertGatewayAdminFleetTopologyInstance(
      {
        peerId: 'child-prod',
        agentCardUrl: 'https://child.example.com/.well-known/agent.json',
        deliveryUrl: 'https://child.example.com/a2a',
        publicKeyJwk: peerPublicKeyJwk(),
        reason: 'unit test',
      },
      {
        fetchImpl: jsonFetch({
          url: 'https://child.example.com/a2a',
          version: '0.99.0',
          hybridclaw: { instanceId: 'child-prod', version: '0.99.0' },
        }),
      },
    );

    expect(topology.hq).toMatchObject({
      instanceId: 'hq-dev',
      status: 'local',
    });
    expect(topology.instances).toHaveLength(1);
    expect(topology.instances[0]).toMatchObject({
      peerId: 'child-prod',
      status: 'online',
      trustStatus: 'trusted',
      version: '0.99.0',
      error: null,
    });
    expect(topology.instances[0]?.latencyMs).toEqual(expect.any(Number));
  });

  test('reports unconfigured instances without probing the network', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');
    const service = await import('../src/gateway/gateway-fleet-topology.ts');
    const publicKeyJwk = peerPublicKeyJwk();

    initDatabase({ quiet: true });
    trust.upsertA2ATrustedPublicKeyPeer({
      peerId: 'child-unconfigured',
      publicKeyFingerprint: trust.fingerprintA2APublicKey(publicKeyJwk),
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const topology = await service.getGatewayAdminFleetTopology({ fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(topology.instances[0]).toMatchObject({
      peerId: 'child-unconfigured',
      status: 'unconfigured',
      latencyMs: null,
      version: null,
    });
  });

  test('add and remove instance actions are audited', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const service = await import('../src/gateway/gateway-fleet-topology.ts');

    initDatabase({ quiet: true });
    await service.upsertGatewayAdminFleetTopologyInstance(
      {
        peerId: 'audited-child',
        publicKeyJwk: peerPublicKeyJwk(),
        reason: 'operator add',
      },
      { fetchImpl: vi.fn() as unknown as typeof fetch },
    );
    await service.deleteGatewayAdminFleetTopologyInstance({
      peerId: 'audited-child',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const auditTypes = getRecentStructuredAuditForSession(
      'a2a:trust-ledger',
      10,
    ).map((entry) => entry.event_type);
    expect(auditTypes).toContain('a2a.trust.operator_override');
    expect(auditTypes).toContain('a2a.trust.deleted');
  });
});
