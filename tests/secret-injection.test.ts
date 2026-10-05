import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import YAML from 'yaml';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-secret-policy-');

function mockRuntimeSecrets(
  readStoredRuntimeSecret: (name: string) => string | null,
): void {
  vi.doMock('../src/security/runtime-secrets.js', () => ({
    RUNTIME_MASTER_KEY_ENV: 'HYBRIDCLAW_MASTER_KEY',
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

  const allowWhen = (when: unknown) => ({ when, action: 'allow' });

  test.each([
    {
      name: 'a misspelled when key',
      rule: { wehn: { predicate: 'secret.id', equals: 'DATEV_*' }, action: 'allow' },
      error: /secret rule #1 .*"wehn"/,
    },
    {
      name: 'its when body indented as rule keys',
      rule: { when: null, predicate: 'secret.id', equals: 'DATEV_*', action: 'allow' },
      error: /secret rule #1 .*"predicate"/,
    },
    { name: 'a scalar rule', rule: 'allow', error: /secret rule #1 .*"allow"/ },
    {
      name: 'a misspelled composite parameter',
      rule: allowWhen({
        predicate: 'secret_resolve_allowed',
        id: 'DATEV_*',
        hots: '*.datev.de',
      }),
      error: /secret rule #1 when .*"hots"/,
    },
    {
      name: 'a misspelled parameter inside all',
      rule: allowWhen({
        all: [
          { predicate: 'secret.id', equals: 'DATEV_*' },
          { predicate: 'secret.host', equal: '*.datev.de' },
        ],
      }),
      error: /secret rule #1 when\.all\[1\] .*"equal"/,
    },
    {
      name: 'a misspelled parameter inside not',
      rule: allowWhen({ not: { predicate: 'skill.name', equal: 'untrusted' } }),
      error: /secret rule #1 when\.not .*"equal"/,
    },
    {
      name: 'an unknown predicate',
      rule: allowWhen({ predicate: 'secret.hots', equals: '*.datev.de' }),
      error: /secret rule #1 when predicate .*"secret\.hots"/,
    },
    {
      name: 'an inherited object key as predicate',
      rule: allowWhen({ predicate: 'constructor' }),
      error: /secret rule #1 when predicate .*"constructor"/,
    },
    { name: 'a string when', rule: allowWhen('always'), error: /secret rule #1 when .*"always"/ },
    { name: 'a false when', rule: allowWhen(false), error: /secret rule #1 when .*false/ },
    { name: 'an empty when', rule: allowWhen(null), error: /secret rule #1 when .*null/ },
    { name: 'an empty when list', rule: allowWhen([]), error: /secret rule #1 when .*empty list/ },
    {
      name: 'an empty all list',
      rule: allowWhen({ all: [] }),
      error: /secret rule #1 when\.all .*empty list/,
    },
    {
      name: 'any given as a mapping',
      rule: allowWhen({ any: { predicate: 'secret.id', equals: 'DATEV_*' } }),
      error: /secret rule #1 when\.any .*not a list/,
    },
    {
      name: 'two operators in one node',
      rule: allowWhen({
        predicate: 'secret.id',
        equals: 'DATEV_*',
        not: { predicate: 'agent.id', equals: 'main' },
      }),
      error: /secret rule #1 when .*"not"/,
    },
    {
      name: 'a parameter next to all',
      rule: allowWhen({
        all: [{ predicate: 'secret.id', equals: 'DATEV_*' }],
        host: '*.datev.de',
      }),
      error: /secret rule #1 when .*"host"/,
    },
    {
      name: 'a predicate without parameters',
      rule: allowWhen({ predicate: 'secret.id' }),
      error: /secret rule #1 when needs .*equals, matches, in/,
    },
    {
      name: 'two spellings of one parameter',
      rule: allowWhen({
        predicate: 'secret_resolve_allowed',
        id: 'DATEV_*',
        secret: '*',
      }),
      error: /secret rule #1 when sets both id and secret/,
    },
    {
      name: 'an empty parameter value',
      rule: allowWhen({
        predicate: 'secret_resolve_allowed',
        id: null,
        host: '*.datev.de',
      }),
      error: /secret rule #1 when\.id .*null/,
    },
    {
      name: 'a mapping parameter value',
      rule: allowWhen({
        predicate: 'secret_resolve_allowed',
        skill: { equals: 'datev-login' },
      }),
      error: /secret rule #1 when\.skill .*"datev-login"/,
    },
    {
      name: 'a host list',
      rule: allowWhen({
        predicate: 'secret.host',
        equals: ['*.datev.de', 'datev.de'],
      }),
      error: /secret rule #1 when\.equals .*\["\*\.datev\.de"/,
    },
    {
      name: 'an unknown sink',
      rule: allowWhen({ predicate: 'secret_resolve_allowed', sink: 'websocket' }),
      error: /secret rule #1 when\.sink .*"websocket"/,
    },
    {
      name: 'a misspelled sink in a list',
      rule: allowWhen({ predicate: 'secret.sink', in: ['dom', 'htpp'] }),
      error: /secret rule #1 when\.in .*"htpp"/,
    },
    {
      name: 'an unknown source',
      rule: allowWhen({ predicate: 'secret.source', equals: 'env' }),
      error: /secret rule #1 when\.equals .*"env"/,
    },
    {
      name: 'a when that contains itself',
      rule: allowWhen(YAML.parse('&loop {not: *loop}')),
      error: /secret rule #1 when\.not .*itself/,
    },
  ])('a rule with $name throws instead of resolving', async ({
    rule,
    error,
  }) => {
    const { readSecretPolicyStateFromDocument } = await import(
      '../src/security/secret-policy.js'
    );

    expect(() =>
      readSecretPolicyStateFromDocument({
        secret: { default: 'deny', rules: [rule] },
      }),
    ).toThrow(error);
  });

  test.each([
    {
      name: 'annotation and managed_by keys',
      rule: {
        id: 'allow-datev',
        description: 'DATEV login',
        comment: 'owner: finance',
        managed_by_example: true,
        ...allowWhen({ predicate: 'secret.id', equals: 'DATEV_*' }),
      },
      decision: 'allow',
    },
    {
      name: 'a when list',
      rule: allowWhen([
        { predicate: 'secret.id', equals: 'DATEV_*' },
        { predicate: 'secret.sink', equals: 'http' },
      ]),
      decision: 'deny',
    },
    {
      name: 'not over a list',
      rule: allowWhen({
        not: [
          { predicate: 'secret.id', equals: 'DATEV_*' },
          { predicate: 'secret.sink', equals: 'http' },
        ],
      }),
      decision: 'allow',
    },
    {
      name: 'mixed-case sinks',
      rule: allowWhen({ predicate: 'secret_resolve_allowed', sinks: ['HTTP', 'Dom'] }),
      decision: 'allow',
    },
    {
      name: 'a wildcard sink',
      rule: allowWhen({ predicate: 'secret.sink', in: '*' }),
      decision: 'allow',
    },
  ])('a rule with $name resolves as $decision', async ({ rule, decision }) => {
    const { evaluateSecretPolicyAccess, readSecretPolicyStateFromDocument } =
      await import('../src/security/secret-policy.js');

    expect(
      evaluateSecretPolicyAccess({
        state: readSecretPolicyStateFromDocument({
          secret: { default: 'deny', rules: [rule] },
        }),
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

  test('parses the rule secret route add writes', async () => {
    const workspacePath = makeTempDir();
    const policyPath = path.join(workspacePath, '.hybridclaw', 'policy.yaml');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, ['secret:', '  default: deny', ''].join('\n'));
    const { allowHttpSecretRouteInWorkspacePolicy } = await import(
      '../src/policy/secret-route-policy.js'
    );
    const {
      clearSecretPolicyStateCache,
      evaluateSecretPolicyAccess,
      readWorkspaceSecretPolicyState,
    } = await import('../src/security/secret-policy.js');

    allowHttpSecretRouteInWorkspacePolicy({
      workspacePath,
      urlPrefix: 'https://api.example.com/v1',
      header: 'X-API-Key',
      secret: { source: 'store', id: 'EXAMPLE_API_KEY' },
      agentId: 'main',
    });
    clearSecretPolicyStateCache();
    const state = readWorkspaceSecretPolicyState(workspacePath);
    const context = {
      agentId: 'main',
      secretSource: 'store' as const,
      secretId: 'EXAMPLE_API_KEY',
      sinkKind: 'http' as const,
      host: 'api.example.com',
      selector: 'X-API-Key',
    };

    expect(evaluateSecretPolicyAccess({ state, context }).decision).toBe(
      'allow',
    );
    expect(
      evaluateSecretPolicyAccess({
        state,
        context: { ...context, host: 'evil.example.com' },
      }).decision,
    ).toBe('deny');
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
    {
      name: 'a misspelled rule parameter',
      policy: [
        'secret:',
        '  default: deny',
        '  rules:',
        '    - action: allow',
        '      when:',
        '        predicate: secret_resolve_allowed',
        '        id: AIRTABLE_PAT',
        '        hots: "*.example.com"',
      ],
    },
    {
      name: 'a misspelled when key',
      policy: [
        'secret:',
        '  default: deny',
        '  rules:',
        '    - action: allow',
        '      wehn:',
        '        predicate: secret.host',
        '        equals: "*.example.com"',
      ],
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
