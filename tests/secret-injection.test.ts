import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-secret-policy-');

function mockRuntimeSecrets(
  readStoredRuntimeSecret: (name: string) => string | null,
): void {
  vi.doMock('../src/security/runtime-secrets.js', () => ({
    isRuntimeSecretName: (value: string) =>
      /^[A-Z][A-Z0-9_]{0,127}$/.test(value),
    loadRuntimeSecrets: vi.fn(),
    migrateLegacyRuntimeSecretsFile: vi.fn(() => false),
    readStoredRuntimeSecret,
    readStoredRuntimeSecrets: vi.fn(() => ({})),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('SecretRef', () => {
  test('hardened refs block accidental coercion and JSON serialization', async () => {
    const { hardenSecretRef } = await import('../src/security/secret-refs.js');

    const ref = hardenSecretRef({
      source: 'store',
      id: 'HYBRIDCLAW_TEST_SECRET',
    });

    expect(ref).toMatchObject({
      source: 'store',
      id: 'HYBRIDCLAW_TEST_SECRET',
    });
    expect(Object.keys(ref).sort()).toEqual(['id', 'source']);
    expect(() => String(ref)).toThrow(/SecretRef cannot be coerced/i);
    expect(() => `${ref}`).toThrow(/SecretRef cannot be coerced/i);
    expect(() => JSON.stringify(ref)).toThrow(
      /SecretRef cannot be JSON-stringified/i,
    );
  });
});

describe('SecretHandle', () => {
  test('blocks accidental coercion and JSON serialization', async () => {
    mockRuntimeSecrets((name) =>
      name === 'HYBRIDCLAW_TEST_SECRET' ? 'super-secret-value' : null,
    );
    const { resolveSecretHandleInput } = await import(
      '../src/security/secret-refs.js'
    );
    const { unsafeEscapeSecretHandle } = await import(
      '../src/security/secret-handles.js'
    );

    const audit = vi.fn();
    const handle = resolveSecretHandleInput(
      { source: 'store', id: 'HYBRIDCLAW_TEST_SECRET' },
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
    mockRuntimeSecrets((name) =>
      name === 'HYBRIDCLAW_TEST_SECRET' ? 'header-secret-value' : null,
    );
    const { resolveSecretInput } = await import(
      '../src/security/secret-refs.js'
    );
    const { withSecretHeader } = await import(
      '../src/security/secret-handles.js'
    );

    const resolved = resolveSecretInput(
      { source: 'store', id: 'HYBRIDCLAW_TEST_SECRET' },
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
  test.each([
    { name: 'no secret section', policy: {}, decision: 'allow' },
    { name: 'an empty secret section', policy: { secret: null }, decision: 'allow' },
    { name: 'rules and no default', policy: { secret: { rules: [] } }, decision: 'allow' },
    {
      name: 'empty default and rules',
      policy: { secret: { default: null, rules: null } },
      decision: 'allow',
    },
    { name: 'default allow', policy: { secret: { default: 'allow' } }, decision: 'allow' },
    { name: 'default deny', policy: { secret: { default: 'deny' } }, decision: 'deny' },
    { name: 'default block', policy: { secret: { default: 'block' } }, decision: 'deny' },
    { name: 'default " Deny "', policy: { secret: { default: ' Deny ' } }, decision: 'deny' },
    {
      name: 'a block rule',
      policy: { secret: { rules: [{ action: 'block' }] } },
      decision: 'deny',
    },
    {
      name: 'a typed deny rule',
      policy: { secret: { rules: [{ action: { type: 'deny', reason: 'test' } }] } },
      decision: 'deny',
    },
  ])('$name resolves as $decision', async ({ policy, decision }) => {
    const { evaluateSecretPolicyAccess, readSecretPolicyStateFromDocument } =
      await import('../src/security/secret-policy.js');

    expect(
      evaluateSecretPolicyAccess({
        state: readSecretPolicyStateFromDocument(policy),
        context: {
          agentId: 'main',
          secretSource: 'store',
          secretId: 'DATEV_PASSWORD',
          sinkKind: 'dom',
          host: 'login.datev.de',
          selector: '#password',
        },
      }).decision,
    ).toBe(decision);
  });

  test.each([
    {
      name: 'a misspelled default',
      policy: { secret: { default: 'denied' } },
      error: /secret\.default .*"denied"/,
    },
    {
      name: 'an empty-string default',
      policy: { secret: { default: '' } },
      error: /secret\.default .*""/,
    },
    {
      name: 'a boolean default',
      policy: { secret: { default: false } },
      error: /secret\.default .*false/,
    },
    {
      name: 'a list default',
      policy: { secret: { default: ['deny'] } },
      error: /secret\.default .*\["deny"\]/,
    },
    {
      name: 'a scalar secret section',
      policy: { secret: 'deny' },
      error: /secret must be a mapping .*"deny"/,
    },
    {
      name: 'rules given as a mapping',
      policy: { secret: { rules: { action: 'deny' } } },
      error: /secret\.rules must be a list/,
    },
    {
      name: 'a misspelled rule action',
      policy: { secret: { rules: [{ action: 'deny' }, { action: 'denny' }] } },
      error: /secret rule #2 action .*"denny"/,
    },
    {
      name: 'a misspelled typed rule action',
      policy: { secret: { rules: [{ action: { type: 'denny' } }] } },
      error: /secret rule #1 action .*"denny"/,
    },
    {
      name: 'a rule without an action',
      policy: {
        secret: { rules: [{ when: { predicate: 'secret.id', equals: 'DATEV_*' } }] },
      },
      error: /secret rule #1 action/,
    },
  ])('$name throws instead of resolving', async ({ policy, error }) => {
    const { readSecretPolicyStateFromDocument } = await import(
      '../src/security/secret-policy.js'
    );

    expect(() => readSecretPolicyStateFromDocument(policy)).toThrow(error);
  });

  test('allows host and selector scoped rules through the F3 policy engine', async () => {
    const { evaluateSecretPolicyAccess, readSecretPolicyStateFromDocument } =
      await import('../src/security/secret-policy.js');

    const state = readSecretPolicyStateFromDocument({
      secret: {
        default: 'deny',
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

  test('allows composed fine-grained F3 secret policy predicates', async () => {
    const { evaluateSecretPolicyAccess, readSecretPolicyStateFromDocument } =
      await import('../src/security/secret-policy.js');

    const state = readSecretPolicyStateFromDocument({
      secret: {
        default: 'deny',
        rules: [
          {
            when: {
              all: [
                { predicate: 'secret.id', matches: 'DATEV_*' },
                { predicate: 'secret.source', equals: 'store' },
                { predicate: 'secret.sink', equals: 'dom' },
                { predicate: 'secret.host', matches: '*.datev.de' },
                { predicate: 'secret.selector', matches: '#pass*' },
                { predicate: 'skill.name', equals: 'datev-login' },
                { predicate: 'agent.id', equals: 'main' },
              ],
            },
            action: 'allow',
          },
        ],
      },
    });

    const context = {
      agentId: 'main',
      skillName: 'datev-login',
      secretSource: 'store' as const,
      secretId: 'DATEV_PASSWORD',
      sinkKind: 'dom' as const,
      host: 'login.datev.de',
      selector: '#password',
    };

    expect(evaluateSecretPolicyAccess({ state, context }).decision).toBe(
      'allow',
    );
    expect(
      evaluateSecretPolicyAccess({
        state,
        context: { ...context, selector: '#username' },
      }).decision,
    ).toBe('deny');
  });

  test('matches wildcard predicates when optional context values are empty', async () => {
    const { evaluateSecretPolicyAccess, readSecretPolicyStateFromDocument } =
      await import('../src/security/secret-policy.js');

    const state = readSecretPolicyStateFromDocument({
      secret: {
        rules: [
          {
            when: {
              predicate: 'secret_resolve_allowed',
              skill: '*',
              sink: 'dom',
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
          secretSource: 'store',
          secretId: 'DATEV_PASSWORD',
          sinkKind: 'dom',
          host: 'login.datev.de',
          selector: '#password',
        },
      }).decision,
    ).toBe('allow');
  });

  test.each([
    { predicate: 'secret.id', pattern: 'KEY_?', value: 'KEY_1', decision: 'allow' },
    { predicate: 'secret.id', pattern: 'KEY_?', value: 'KEY_12', decision: 'deny' },
    { predicate: 'secret.id', pattern: '?_TOKEN', value: 'A_TOKEN', decision: 'allow' },
    { predicate: 'secret.selector', pattern: '#pass?ord', value: '#password', decision: 'allow' },
    { predicate: 'secret.selector', pattern: '#pass?ord', value: '#passwd', decision: 'deny' },
  ])('$predicate glob $pattern vs $value: $decision', async ({
    predicate,
    pattern,
    value,
    decision,
  }) => {
    const { evaluateSecretPolicyAccess, readSecretPolicyStateFromDocument } =
      await import('../src/security/secret-policy.js');

    const state = readSecretPolicyStateFromDocument({
      secret: {
        default: 'deny',
        rules: [{ when: { predicate, matches: pattern }, action: 'allow' }],
      },
    });

    expect(
      evaluateSecretPolicyAccess({
        state,
        context: {
          secretSource: 'store',
          secretId: predicate === 'secret.id' ? value : 'KEY_1',
          sinkKind: 'dom',
          selector: predicate === 'secret.selector' ? value : '#password',
        },
      }).decision,
    ).toBe(decision);
  });

  test('caches workspace secret policy reads until the policy file changes', async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-secret-policy-cache-'),
    );
    const policyPath = path.join(workspacePath, '.hybridclaw', 'policy.yaml');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(
      policyPath,
      ['secret:', '  default: allow', ''].join('\n'),
      'utf8',
    );
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const { clearSecretPolicyStateCache, readWorkspaceSecretPolicyState } =
      await import('../src/security/secret-policy.js');

    clearSecretPolicyStateCache();
    expect(readWorkspaceSecretPolicyState(workspacePath).defaultAction).toBe(
      'allow',
    );
    expect(readWorkspaceSecretPolicyState(workspacePath).defaultAction).toBe(
      'allow',
    );

    let policyReads = readFileSync.mock.calls.filter(
      ([file]) => String(file) === policyPath,
    );
    expect(policyReads).toHaveLength(1);

    fs.writeFileSync(
      policyPath,
      ['secret:', '  default: deny', '  rules: []', ''].join('\n'),
      'utf8',
    );

    expect(readWorkspaceSecretPolicyState(workspacePath).defaultAction).toBe(
      'deny',
    );
    policyReads = readFileSync.mock.calls.filter(
      ([file]) => String(file) === policyPath,
    );
    expect(policyReads).toHaveLength(2);
    readFileSync.mockRestore();

    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test('names the invalid policy file until it is fixed', async () => {
    const workspacePath = makeTempDir();
    const policyPath = path.join(workspacePath, '.hybridclaw', 'policy.yaml');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, ['secret:', '  default: denied', ''].join('\n'));
    const { clearSecretPolicyStateCache, readWorkspaceSecretPolicyState } =
      await import('../src/security/secret-policy.js');

    clearSecretPolicyStateCache();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => readWorkspaceSecretPolicyState(workspacePath)).toThrow(
        `Invalid secret policy in ${policyPath}: secret.default`,
      );
    }

    fs.writeFileSync(policyPath, ['secret:', '  default: deny', ''].join('\n'));
    expect(readWorkspaceSecretPolicyState(workspacePath).defaultAction).toBe(
      'deny',
    );
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

  test('keeps runtime leak rule ids unique after per-session rollover', async () => {
    const { rememberResolvedSecretForLeakScan, withResolvedSecretLeakRules } =
      await import('../src/security/secret-leak-corpus.js');

    for (let index = 0; index < 101; index += 1) {
      rememberResolvedSecretForLeakScan({
        sessionId: 'session-secret-corpus-rollover',
        secretId: `SECRET_${index}`,
        value: `cleartext-secret-${index}`,
      });
    }

    const ruleSet = withResolvedSecretLeakRules(
      'session-secret-corpus-rollover',
      {
        rules: [],
        sourcePath: null,
      },
    );
    const ids = ruleSet.rules.map((rule) => rule.id);
    expect(ruleSet.rules).toHaveLength(100);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('runtime_secret_101');
  });
});

describe('gateway secret injection', () => {
  test('allows existing stored secrets by default when no policy rule matches', async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-secret-policy-default-'),
    );
    const recordAuditEvent = vi.fn();

    vi.doMock('../src/infra/ipc.js', () => ({
      agentWorkspaceDir: () => workspacePath,
    }));
    vi.doMock('../src/audit/audit-events.js', () => ({
      makeAuditRunId: () => 'run-secret',
      recordAuditEvent,
    }));
    mockRuntimeSecrets((name) =>
      name === 'AIRTABLE_PAT' ? 'pat-cleartext-secret' : null,
    );

    const { resolveStoredSecretForInjection } = await import(
      '../src/gateway/gateway-secret-injection.js'
    );

    expect(
      resolveStoredSecretForInjection({
        secretName: 'AIRTABLE_PAT',
        sessionId: 'agent:main:channel:web:chat:dm:peer:test',
        skillName: 'airtable',
        sinkKind: 'http',
        host: 'api.airtable.com',
        selector: 'Authorization',
      }),
    ).toBe('pat-cleartext-secret');

    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test('reports missing stored secrets instead of policy blocks', async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-secret-policy-missing-'),
    );

    vi.doMock('../src/infra/ipc.js', () => ({
      agentWorkspaceDir: () => workspacePath,
    }));
    vi.doMock('../src/audit/audit-events.js', () => ({
      makeAuditRunId: () => 'run-secret',
      recordAuditEvent: vi.fn(),
    }));
    mockRuntimeSecrets(() => null);

    const { resolveStoredSecretForInjection } = await import(
      '../src/gateway/gateway-secret-injection.js'
    );

    expect(() =>
      resolveStoredSecretForInjection({
        secretName: 'HERMES3000_JWT',
        sessionId: 'agent:main:channel:web:chat:dm:peer:test',
        skillName: 'hermes3000-writing',
        sinkKind: 'http',
        host: 'hermes3000.ai',
        selector: 'Authorization',
      }),
    ).toThrow('Stored secret HERMES3000_JWT is not set.');

    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test('honors explicit stored-secret deny rules over default allow', async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-secret-policy-deny-'),
    );
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      [
        'secret:',
        '  rules:',
        '    - when:',
        '        predicate: secret_resolve_allowed',
        '        id: AIRTABLE_PAT',
        '        source: store',
        '        sink: http',
        '        host: api.airtable.com',
        '        selector: Authorization',
        '      action: deny',
        '',
      ].join('\n'),
    );

    vi.doMock('../src/infra/ipc.js', () => ({
      agentWorkspaceDir: () => workspacePath,
    }));
    vi.doMock('../src/audit/audit-events.js', () => ({
      makeAuditRunId: () => 'run-secret',
      recordAuditEvent: vi.fn(),
    }));
    mockRuntimeSecrets((name) =>
      name === 'AIRTABLE_PAT' ? 'pat-cleartext-secret' : null,
    );

    const { resolveStoredSecretForInjection } = await import(
      '../src/gateway/gateway-secret-injection.js'
    );

    expect(() =>
      resolveStoredSecretForInjection({
        secretName: 'AIRTABLE_PAT',
        sessionId: 'agent:main:channel:web:chat:dm:peer:test',
        skillName: 'airtable',
        sinkKind: 'http',
        host: 'api.airtable.com',
        selector: 'Authorization',
      }),
    ).toThrow(
      'Secret store:AIRTABLE_PAT is blocked by secret resolution policy.',
    );

    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test.each([
    { name: 'a misspelled default', policy: ['secret:', '  default: denied'] },
    {
      name: 'a misspelled rule action',
      policy: ['secret:', '  rules:', '    - action: denny'],
    },
  ])('fails the resolve on $name without releasing the secret', async ({
    policy,
  }) => {
    const workspacePath = makeTempDir();
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      [...policy, ''].join('\n'),
    );
    const recordAuditEvent = vi.fn();

    vi.doMock('../src/infra/ipc.js', () => ({
      agentWorkspaceDir: () => workspacePath,
    }));
    vi.doMock('../src/audit/audit-events.js', () => ({
      makeAuditRunId: () => 'run-secret',
      recordAuditEvent,
    }));
    mockRuntimeSecrets((name) =>
      name === 'AIRTABLE_PAT' ? 'pat-cleartext-secret' : null,
    );

    const { resolveStoredSecretForInjection } = await import(
      '../src/gateway/gateway-secret-injection.js'
    );

    expect(() =>
      resolveStoredSecretForInjection({
        secretName: 'AIRTABLE_PAT',
        sessionId: 'agent:main:channel:web:chat:dm:peer:test',
        skillName: 'airtable',
        sinkKind: 'http',
        host: 'api.airtable.com',
        selector: 'Authorization',
      }),
    ).toThrow(/^Invalid secret policy in .*policy\.yaml: secret/);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('audits every stored secret resolve with sink metadata', async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-secret-policy-'),
    );
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      ['secret:', '  default: allow', ''].join('\n'),
    );
    const recordAuditEvent = vi.fn();

    vi.doMock('../src/infra/ipc.js', () => ({
      agentWorkspaceDir: () => workspacePath,
    }));
    vi.doMock('../src/audit/audit-events.js', () => ({
      makeAuditRunId: () => 'run-secret',
      recordAuditEvent,
    }));
    mockRuntimeSecrets((name) =>
      name === 'DATEV_PASSWORD' ? 'datev-cleartext-secret' : null,
    );

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
