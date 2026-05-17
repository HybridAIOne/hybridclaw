import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-admin-secrets-');

describe('gateway admin secrets metadata', () => {
  useCleanMocks({
    resetModules: true,
    unstubAllEnvs: true,
    unmock: ['../src/audit/audit-events.js', '../src/config/runtime-config.js'],
  });

  async function importAdminSecrets(options?: {
    authRules?: Array<{
      secret: unknown;
      urlPrefix?: string;
      header?: string;
      prefix?: string;
    }>;
    runtimeConfig?: unknown;
  }) {
    const dataDir = makeTempDir();
    vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
    vi.stubEnv('HYBRIDCLAW_MASTER_KEY', 'a'.repeat(64));

    const recordAuditEvent = vi.fn();
    vi.doMock('../src/audit/audit-events.js', () => ({
      makeAuditRunId: vi.fn(() => 'secret-metadata-run'),
      recordAuditEvent,
    }));
    vi.doMock('../src/config/runtime-config.js', () => ({
      getRuntimeConfig: () =>
        options?.runtimeConfig || {
          tools: {
            httpRequest: {
              authRules: options?.authRules || [],
            },
          },
        },
    }));

    const runtimeSecrets = await import('../src/security/runtime-secrets.js');
    const adminSecrets = await import(
      '../src/gateway/gateway-admin-secrets.js'
    );
    return {
      adminSecrets,
      recordAuditEvent,
      runtimeSecrets,
    };
  }

  test('lists set and declared-unset secrets with fingerprints only', async () => {
    const { adminSecrets, recordAuditEvent, runtimeSecrets } =
      await importAdminSecrets();
    runtimeSecrets.saveNamedRuntimeSecrets({
      SET_SECRET: 'super-secret-value',
    });

    const response = adminSecrets.getGatewayAdminSecrets({
      audit: {
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
    });
    const setEntry = response.secrets.find(
      (entry) => entry.name === 'SET_SECRET',
    );
    const unsetEntry = response.secrets.find(
      (entry) => entry.name === 'OPENAI_API_KEY',
    );

    expect(setEntry).toMatchObject({
      name: 'SET_SECRET',
      state: 'set',
      fingerprint: {
        length: Buffer.byteLength('super-secret-value', 'utf-8'),
        sha256_prefix: createHash('sha256')
          .update('super-secret-value', 'utf-8')
          .digest('hex')
          .slice(0, 12),
      },
      references: [],
    });
    expect(setEntry?.created_at).toEqual(expect.any(String));
    expect(setEntry?.last_rotated_at).toEqual(expect.any(String));
    expect(unsetEntry).toMatchObject({
      name: 'OPENAI_API_KEY',
      state: 'unset',
      fingerprint: null,
      references: [],
    });
    expect(unsetEntry?.created_at).toEqual(expect.any(String));
    expect(unsetEntry?.last_rotated_at).toEqual(expect.any(String));
    expect(JSON.stringify(response)).not.toContain('super-secret-value');
    expect(recordAuditEvent).toHaveBeenCalledWith({
      sessionId: 'admin:secrets',
      runId: 'secret-metadata-run',
      event: {
        type: 'secret.viewed_metadata',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
        visibleCount: response.secrets.length,
        totalCount: response.total,
        filteredCount: response.filtered,
      },
    });
  });

  test('includes config-declared custom secrets even when unset', async () => {
    const { adminSecrets, runtimeSecrets } = await importAdminSecrets({
      runtimeConfig: {
        browser: {
          browserUseCloud: {
            apiKeyRef: { source: 'store', id: 'DECLARED_SECRET' },
          },
        },
        tools: {
          httpRequest: {
            authRules: [
              {
                urlPrefix: 'https://api.example.com/',
                header: 'Authorization',
                prefix: 'Bearer',
                secret: { source: 'store', id: 'ROUTE_DECLARED_SECRET' },
              },
            ],
          },
        },
      },
    });
    runtimeSecrets.saveNamedRuntimeSecrets({
      SET_SECRET: 'super-secret-value',
    });

    const response = adminSecrets.getGatewayAdminSecrets();
    const declaredEntry = response.secrets.find(
      (entry) => entry.name === 'DECLARED_SECRET',
    );

    expect(declaredEntry).toMatchObject({
      name: 'DECLARED_SECRET',
      state: 'unset',
      fingerprint: null,
      references: [],
    });
    expect(declaredEntry?.created_at).toEqual(expect.any(String));
    expect(declaredEntry?.last_rotated_at).toEqual(expect.any(String));
    expect(response.secrets).toContainEqual(
      expect.objectContaining({
        name: 'ROUTE_DECLARED_SECRET',
        state: 'unset',
        fingerprint: null,
      }),
    );
  });

  test('filters entries through the supplied per-secret predicate', async () => {
    const { adminSecrets, runtimeSecrets } = await importAdminSecrets();
    runtimeSecrets.saveNamedRuntimeSecrets({
      SET_SECRET: 'super-secret-value',
      OTHER_SECRET: 'other-secret-value',
    });

    const response = adminSecrets.getGatewayAdminSecrets({
      canListSecret: (name) => name.startsWith('SET_'),
    });

    expect(response.secrets.map((entry) => entry.name)).toEqual(['SET_SECRET']);
    expect(response.total).toBeGreaterThan(1);
    expect(response.filtered).toBe(response.total - 1);
  });
});
