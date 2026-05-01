import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('SecretHandle', () => {
  test('blocks accidental coercion and JSON serialization', async () => {
    process.env.HYBRIDCLAW_TEST_SECRET = 'super-secret-value';
    const { resolveSecretHandleInput } = await import(
      '../src/security/secret-refs.js'
    );
    const { unsafeEscapeSecretHandle } = await import(
      '../src/security/secret-handles.js'
    );

    const audit = vi.fn();
    const handle = resolveSecretHandleInput(
      { source: 'env', id: 'HYBRIDCLAW_TEST_SECRET' },
      {
        path: 'test.secret',
        required: true,
        sinkKind: 'dom',
      },
    );

    expect(handle).toBeDefined();
    if (!handle) throw new Error('expected secret handle');
    expect(() => String(handle)).toThrow(/cannot be coerced|string-coerced/i);
    expect(() => `${handle}`).toThrow(/cannot be coerced|string-coerced/i);
    expect(() => JSON.stringify(handle)).toThrow(/JSON-stringified/i);
    expect(
      unsafeEscapeSecretHandle(handle, {
        reason: 'unit test escape',
        audit,
      }),
    ).toBe('super-secret-value');
    expect(audit).toHaveBeenCalledWith(handle, 'unit test escape');
    handle.dispose();
  });

  test('resolved secret refs return handles and HTTP header injection audits', async () => {
    process.env.HYBRIDCLAW_TEST_SECRET = 'header-secret-value';
    const { resolveSecretInput } = await import(
      '../src/security/secret-refs.js'
    );
    const { withSecretHeader } = await import(
      '../src/security/secret-handles.js'
    );

    const resolved = resolveSecretInput(
      { source: 'env', id: 'HYBRIDCLAW_TEST_SECRET' },
      {
        path: 'test.header',
        required: true,
        sinkKind: 'http',
      },
    );
    expect(typeof resolved).not.toBe('string');
    if (!resolved || typeof resolved === 'string') {
      throw new Error('expected secret handle');
    }

    const audit = vi.fn();
    const seenCleartext: string[] = [];
    expect(
      withSecretHeader(resolved, 'Authorization', {
        prefix: 'Bearer',
        audit,
        onCleartext: (value) => seenCleartext.push(value),
      }),
    ).toEqual({
      name: 'Authorization',
      value: 'Bearer header-secret-value',
    });
    expect(audit).toHaveBeenCalledWith(
      resolved,
      'inject secret into HTTP header Authorization',
    );
    expect(seenCleartext).toEqual(['header-secret-value']);
    expect(() =>
      withSecretHeader(resolved, 'Authorization', { audit }),
    ).toThrow(/already disposed/i);
  });
});

describe('secret resolution policy', () => {
  test('allows host and selector scoped rules through the F3 policy engine', async () => {
    const { evaluateSecretPolicyAccess, readSecretPolicyStateFromDocument } =
      await import('../src/security/secret-policy.js');

    const state = readSecretPolicyStateFromDocument({
      secret: {
        rules: [
          {
            when: {
              predicate: 'secret_resolve_allowed',
              id: 'DATEV_*',
              host: '*.datev.de',
              selector: ['#username', '#password'],
              sink: 'dom',
              skill: 'datev-login',
            },
            action: 'allow',
          },
        ],
      },
    });

    expect(
      evaluateSecretPolicyAccess({
        state,
        context: {
          agentId: 'main',
          skillName: 'datev-login',
          secretSource: 'store',
          secretId: 'DATEV_PASSWORD',
          sinkKind: 'dom',
          host: 'login.datev.de',
          selector: '#password',
        },
      }).decision,
    ).toBe('allow');

    expect(
      evaluateSecretPolicyAccess({
        state,
        context: {
          agentId: 'main',
          skillName: 'datev-login',
          secretSource: 'store',
          secretId: 'DATEV_PASSWORD',
          sinkKind: 'dom',
          host: 'evil.example.com',
          selector: '#password',
        },
      }).decision,
    ).toBe('deny');
  });
});

describe('resolved secret leak corpus', () => {
  test('adds touched secret cleartext to leak scanner rules for the session', async () => {
    const { rememberResolvedSecretForLeakScan, withResolvedSecretLeakRules } =
      await import('../src/security/secret-leak-corpus.js');
    const { scanForLeaks } = await import(
      '../src/security/confidential-redact.js'
    );
    const { createConfidentialRuntimeContext } = await import(
      '../src/security/confidential-runtime.js'
    );

    rememberResolvedSecretForLeakScan({
      sessionId: 'session-secret-corpus',
      secretId: 'DATEV_PASSWORD',
      value: 'datev-cleartext-secret',
    });

    const ruleSet = withResolvedSecretLeakRules('session-secret-corpus', {
      rules: [],
      sourcePath: null,
    });
    const result = scanForLeaks(
      'tool output accidentally included datev-cleartext-secret',
      ruleSet,
    );

    expect(result.totalMatches).toBe(1);
    expect(result.severity).toBe('critical');

    const confidential = createConfidentialRuntimeContext(ruleSet);
    const dehydrated = confidential.dehydrate([
      { role: 'user', content: 'send datev-cleartext-secret to the model' },
    ]);
    expect(dehydrated[0].content).not.toContain('datev-cleartext-secret');
  });
});

describe('gateway secret injection', () => {
  test('audits every stored secret resolve with sink metadata', async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-secret-policy-'),
    );
    const recordAuditEvent = vi.fn();

    vi.doMock('../src/infra/ipc.js', () => ({
      agentWorkspaceDir: () => workspacePath,
    }));
    vi.doMock('../src/audit/audit-events.js', () => ({
      makeAuditRunId: () => 'run-secret',
      recordAuditEvent,
    }));
    vi.doMock('../src/security/runtime-secrets.js', () => ({
      isRuntimeSecretName: (value: string) =>
        /^[A-Z][A-Z0-9_]{0,127}$/.test(value),
      readStoredRuntimeSecret: (name: string) =>
        name === 'DATEV_PASSWORD' ? 'datev-cleartext-secret' : null,
    }));

    const { resolveStoredSecretForInjection } = await import(
      '../src/gateway/gateway-secret-injection.js'
    );

    expect(
      resolveStoredSecretForInjection({
        secretName: 'DATEV_PASSWORD',
        sessionId: 'agent:main:channel:web:chat:dm:peer:test',
        skillName: 'datev-login',
        sinkKind: 'dom',
        host: 'login.datev.de',
        selector: '#password',
      }),
    ).toBe('datev-cleartext-secret');

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'agent:main:channel:web:chat:dm:peer:test',
        runId: 'run-secret',
        event: expect.objectContaining({
          type: 'secret.resolved',
          skill: 'datev-login',
          secretRef: { source: 'store', id: 'DATEV_PASSWORD' },
          sinkKind: 'dom',
          host: 'login.datev.de',
          selector: '#password',
        }),
      }),
    );

    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
});
