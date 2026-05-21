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
        sessionId: 'admin-session-1',
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
    });
    expect(setEntry?.created_at).toEqual(expect.any(String));
    expect(setEntry?.last_rotated_at).toEqual(expect.any(String));
    expect(unsetEntry).toMatchObject({
      name: 'OPENAI_API_KEY',
      state: 'unset',
      fingerprint: null,
    });
    expect(unsetEntry?.created_at).toBeNull();
    expect(unsetEntry?.last_rotated_at).toBeNull();
    expect(JSON.stringify(response)).not.toContain('super-secret-value');
    expect(recordAuditEvent).toHaveBeenCalledWith({
      sessionId: 'admin-session-1',
      runId: 'secret-metadata-run',
      event: {
        type: 'secret.viewed_metadata',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
        visibleCount: response.secrets.length,
        totalCount: response.total,
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

    const response = adminSecrets.getGatewayAdminSecrets({
      audit: {
        actor: 'admin-user',
      },
    });
    const declaredEntry = response.secrets.find(
      (entry) => entry.name === 'DECLARED_SECRET',
    );

    expect(declaredEntry).toMatchObject({
      name: 'DECLARED_SECRET',
      state: 'unset',
      fingerprint: null,
    });
    expect(declaredEntry?.created_at).toBeNull();
    expect(declaredEntry?.last_rotated_at).toBeNull();
    expect(response.secrets).toContainEqual(
      expect.objectContaining({
        name: 'ROUTE_DECLARED_SECRET',
        state: 'unset',
        fingerprint: null,
      }),
    );
  });

  test('always emits an audit event for metadata listing', async () => {
    const { adminSecrets, recordAuditEvent } = await importAdminSecrets();

    const response = adminSecrets.getGatewayAdminSecrets({
      audit: {
        actor: 'admin-user',
      },
    });

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'admin-user',
        event: expect.objectContaining({
          type: 'secret.viewed_metadata',
          actor: 'admin-user',
          visibleCount: response.secrets.length,
          totalCount: response.total,
        }),
      }),
    );
  });

  test('overwrites a secret and returns only post-write metadata', async () => {
    const { adminSecrets, recordAuditEvent, runtimeSecrets } =
      await importAdminSecrets();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-17T10:00:00.000Z'));
      runtimeSecrets.saveNamedRuntimeSecrets({
        ROTATE_SECRET: 'old-secret-value',
      });

      vi.setSystemTime(new Date('2026-05-17T10:10:00.000Z'));
      const response = adminSecrets.overwriteGatewayAdminSecret({
        name: 'ROTATE_SECRET',
        value: 'new-secret-value',
        audit: {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          sourceIp: '127.0.0.1',
        },
      });

      expect(runtimeSecrets.readStoredRuntimeSecret('ROTATE_SECRET')).toBe(
        'new-secret-value',
      );
      expect(response.secret).toMatchObject({
        name: 'ROTATE_SECRET',
        state: 'set',
        created_at: '2026-05-17T10:00:00.000Z',
        last_rotated_at: '2026-05-17T10:10:00.000Z',
        fingerprint: {
          length: Buffer.byteLength('new-secret-value', 'utf-8'),
          sha256_prefix: createHash('sha256')
            .update('new-secret-value', 'utf-8')
            .digest('hex')
            .slice(0, 12),
        },
      });
      expect(JSON.stringify(response)).not.toContain('new-secret-value');
      expect(recordAuditEvent).toHaveBeenCalledWith({
        sessionId: 'admin-session-1',
        runId: 'secret-metadata-run',
        event: {
          type: 'secret.overwritten',
          actor: 'admin-user',
          sourceIp: '127.0.0.1',
          name: 'ROTATE_SECRET',
          success: true,
          fingerprint: response.secret.fingerprint,
        },
      });
      expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain(
        'new-secret-value',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('unsets a declared secret while preserving the unset metadata entry', async () => {
    const { adminSecrets, recordAuditEvent, runtimeSecrets } =
      await importAdminSecrets({
        runtimeConfig: {
          tools: {
            httpRequest: {
              authRules: [
                {
                  secret: { source: 'store', id: 'DECLARED_SECRET' },
                },
              ],
            },
          },
        },
      });
    runtimeSecrets.saveNamedRuntimeSecrets({
      DECLARED_SECRET: 'old-secret-value',
    });

    const response = adminSecrets.unsetGatewayAdminSecret({
      name: 'DECLARED_SECRET',
      audit: {
        sessionId: 'admin-session-1',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
    });

    expect(
      runtimeSecrets.readStoredRuntimeSecret('DECLARED_SECRET'),
    ).toBeNull();
    expect(response.secret).toMatchObject({
      name: 'DECLARED_SECRET',
      state: 'unset',
      created_at: null,
      last_rotated_at: null,
      fingerprint: null,
    });
    expect(recordAuditEvent).toHaveBeenCalledWith({
      sessionId: 'admin-session-1',
      runId: 'secret-metadata-run',
      event: {
        type: 'secret.unset',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
        name: 'DECLARED_SECRET',
        success: true,
        fingerprint: null,
      },
    });
  });

  test('unset is idempotent for already-unset declared secrets', async () => {
    const { adminSecrets, runtimeSecrets } = await importAdminSecrets({
      runtimeConfig: {
        tools: {
          httpRequest: {
            authRules: [
              {
                secret: { source: 'store', id: 'DECLARED_SECRET' },
              },
            ],
          },
        },
      },
    });

    const first = adminSecrets.unsetGatewayAdminSecret({
      name: 'DECLARED_SECRET',
      audit: {
        actor: 'admin-user',
      },
    });
    const second = adminSecrets.unsetGatewayAdminSecret({
      name: 'DECLARED_SECRET',
      audit: {
        actor: 'admin-user',
      },
    });

    expect(
      runtimeSecrets.readStoredRuntimeSecret('DECLARED_SECRET'),
    ).toBeNull();
    expect(first.secret).toEqual(second.secret);
    expect(second.secret).toMatchObject({
      name: 'DECLARED_SECRET',
      state: 'unset',
      fingerprint: null,
    });
  });

  test('overwrite validation failure does not persist or audit cleartext', async () => {
    const { adminSecrets, recordAuditEvent, runtimeSecrets } =
      await importAdminSecrets();

    expect(() =>
      adminSecrets.overwriteGatewayAdminSecret({
        name: 'INVALID-SECRET',
        value: 'should-not-leak',
        audit: {
          actor: 'admin-user',
        },
      }),
    ).toThrow('Invalid secret name');

    expect(runtimeSecrets.readStoredRuntimeSecret('INVALID_SECRET')).toBeNull();
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain(
      'should-not-leak',
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'secret.overwritten',
          success: false,
          fingerprint: null,
          errorCode: 'bad_request',
        }),
      }),
    );
  });
});
