import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import YAML from 'yaml';

import type { NetworkRule } from '../src/policy/network-policy.js';
import {
  addPolicyRule,
  deletePolicyRule,
  readPolicyState,
  resetPolicyNetwork,
  resolveWorkspacePolicyPath,
  setLanHttpAccessMode,
  setPolicyDefault,
  setPolicyPresets,
  updatePolicyRule,
} from '../src/policy/policy-store.js';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-policy-store-'));
}

function writePolicy(workspacePath: string, raw: string): void {
  const policyPath = resolveWorkspacePolicyPath(workspacePath);
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, `${raw.trim()}\n`, 'utf-8');
}

function readPolicyDocument(workspacePath: string): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(resolveWorkspacePolicyPath(workspacePath), 'utf-8'),
  ) as Record<string, unknown>;
}

test('reads the default network policy when policy.yaml is missing', () => {
  const workspacePath = makeWorkspace();

  const state = readPolicyState(workspacePath);

  expect(state.exists).toBe(false);
  expect(state.defaultAction).toBe('deny');
  expect(state.presets).toEqual([]);
  expect(state.rules).toEqual([
    expect.objectContaining({
      index: 1,
      action: 'allow',
      host: 'hybridaione.github.io',
      port: 443,
      methods: ['*'],
      paths: ['/hybridclaw/**'],
      agent: '*',
    }),
  ]);
});

test('migrates legacy trusted_network_hosts into structured rules and removes the legacy field on write', () => {
  const workspacePath = makeWorkspace();
  writePolicy(
    workspacePath,
    `
approval:
  trusted_network_hosts:
    - api.github.com
    - docs.python.org
`,
  );

  const initial = readPolicyState(workspacePath);
  expect(initial.rules.map((rule) => rule.host)).toEqual([
    'api.github.com',
    'docs.python.org',
  ]);
  expect(initial.rules.every((rule) => rule.action === 'allow')).toBe(true);
  expect(initial.rules.every((rule) => rule.port === '*')).toBe(true);

  addPolicyRule(workspacePath, {
    action: 'deny',
    host: 'evil.example',
    port: 443,
    methods: ['*'],
    paths: ['/**'],
    agent: '*',
  });

  const document = readPolicyDocument(workspacePath);
  expect(
    (document.approval as { trusted_network_hosts?: unknown })
      ?.trusted_network_hosts,
  ).toBeUndefined();
  expect(
    (
      (document.network as { rules?: Array<{ host?: string }> }).rules || []
    ).map((rule) => rule.host),
  ).toEqual(['api.github.com', 'docs.python.org', 'evil.example']);
});

test('updates default action, deletes rules by host, and resets to the packaged default', () => {
  const workspacePath = makeWorkspace();
  const customRule: NetworkRule = {
    action: 'allow',
    host: 'api.openai.com',
    port: 443,
    methods: ['GET', 'POST'],
    paths: ['/v1/**'],
    agent: 'research',
    comment: 'Research agent',
  };

  addPolicyRule(workspacePath, customRule);
  let state = setPolicyDefault(workspacePath, 'allow');
  expect(state.defaultAction).toBe('allow');
  expect(state.rules).toHaveLength(2);

  const deleted = deletePolicyRule(workspacePath, 'api.openai.com');
  expect(deleted.deleted).toHaveLength(1);
  expect(deleted.deleted[0]?.host).toBe('api.openai.com');
  state = deleted.state;
  expect(state.rules).toEqual([
    expect.objectContaining({ host: 'hybridaione.github.io' }),
  ]);

  state = resetPolicyNetwork(workspacePath);
  expect(state.defaultAction).toBe('deny');
  expect(state.presets).toEqual([]);
  expect(state.rules).toEqual([
    expect.objectContaining({
      host: 'hybridaione.github.io',
      action: 'allow',
      methods: ['*'],
      paths: ['/hybridclaw/**'],
      agent: '*',
    }),
  ]);
});

test('network writes stay confined to the network section', () => {
  const workspacePath = makeWorkspace();

  addPolicyRule(workspacePath, {
    action: 'allow',
    host: 'example.com',
    port: 443,
    methods: ['GET'],
    paths: ['/docs/**'],
    agent: 'main',
  });

  const document = readPolicyDocument(workspacePath);
  expect(document.approval).toBeUndefined();
  expect(document.audit).toBeUndefined();
  expect(document.network).toMatchObject({
    default: 'deny',
    presets: [],
  });
});

test('managed LAN HTTP access writes RFC1918-only policy rules', () => {
  const workspacePath = makeWorkspace();

  let state = setLanHttpAccessMode(workspacePath, 'read-only');
  expect(state.lanHttpAccess).toEqual({
    mode: 'read-only',
    managedRuleIndexes: [2, 3, 4],
  });
  expect(state.rules.slice(1)).toEqual([
    expect.objectContaining({
      host: '10.0.0.0/8',
      methods: ['GET'],
      paths: ['/**'],
      managedByPreset: 'lan-http-access',
    }),
    expect.objectContaining({
      host: '172.16.0.0/12',
      methods: ['GET'],
      managedByPreset: 'lan-http-access',
    }),
    expect.objectContaining({
      host: '192.168.0.0/16',
      methods: ['GET'],
      managedByPreset: 'lan-http-access',
    }),
  ]);

  state = setLanHttpAccessMode(workspacePath, 'read-write');
  expect(state.lanHttpAccess.mode).toBe('read-write');
  expect(state.rules.slice(1).map((rule) => rule.methods)).toEqual([
    ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  ]);

  const network = readPolicyDocument(workspacePath).network as {
    rules?: Array<Record<string, unknown>>;
  };
  expect(network.rules?.slice(1).map((rule) => rule.host)).toEqual([
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
  ]);
  expect(network.rules?.slice(1).map((rule) => rule.managed_by_preset)).toEqual(
    ['lan-http-access', 'lan-http-access', 'lan-http-access'],
  );
});

test('LAN HTTP access reports custom when manual private host rules exist', () => {
  const workspacePath = makeWorkspace();

  addPolicyRule(workspacePath, {
    action: 'allow',
    host: '192.168.178.198',
    port: 80,
    methods: ['POST'],
    paths: ['/rpc/**'],
    agent: '*',
  });

  expect(readPolicyState(workspacePath).lanHttpAccess).toEqual({
    mode: 'custom',
    managedRuleIndexes: [],
  });
});

test('wildcard-port rules omit the port field when written to YAML', () => {
  const workspacePath = makeWorkspace();

  addPolicyRule(workspacePath, {
    action: 'allow',
    host: 'example.com',
    port: '*',
    methods: ['*'],
    paths: ['/**'],
    agent: '*',
  });

  const network = readPolicyDocument(workspacePath).network as {
    rules?: Array<Record<string, unknown>>;
  };
  expect(network.rules?.[1]).toMatchObject({
    action: 'allow',
    host: 'example.com',
  });
  expect(network.rules?.[1]).not.toHaveProperty('port');
  expect(readPolicyState(workspacePath).rules[1]).toMatchObject({
    host: 'example.com',
    port: '*',
  });
});

test('invalid YAML rule ports are rejected instead of defaulting to 443', () => {
  const workspacePath = makeWorkspace();
  writePolicy(
    workspacePath,
    `
network:
  default: deny
  rules:
    - action: allow
      host: example.com
      port: abc
`,
  );

  const state = readPolicyState(workspacePath);
  expect(state.rules).toEqual([]);
});

test('store writes fail fast when policy.yaml contains invalid rules', () => {
  const workspacePath = makeWorkspace();
  const policyPath = resolveWorkspacePolicyPath(workspacePath);
  writePolicy(
    workspacePath,
    `
network:
  default: deny
  rules:
    - action: allow
      host: keep.example
    - action: allow
      host: broken.example
      port: abc
`,
  );

  expect(() => setPolicyDefault(workspacePath, 'allow')).toThrow(
    `Policy file contains an invalid network rule at index 2. Fix ${policyPath} before editing it.`,
  );
  expect(fs.readFileSync(policyPath, 'utf-8')).toContain('port: abc');
  expect(readPolicyDocument(workspacePath).network).toMatchObject({
    default: 'deny',
    rules: [
      expect.objectContaining({ host: 'keep.example' }),
      expect.objectContaining({ host: 'broken.example', port: 'abc' }),
    ],
  });
});

test('store mutations reject invalid rule ports with a visible error', () => {
  const workspacePath = makeWorkspace();

  expect(() =>
    addPolicyRule(workspacePath, {
      action: 'allow',
      host: 'example.com',
      port: Number.NaN,
      methods: ['*'],
      paths: ['/**'],
      agent: '*',
    }),
  ).toThrow('Policy rule has an invalid port.');
});

test('stores normalized preset bookkeeping alongside explicit rules', () => {
  const workspacePath = makeWorkspace();

  const state = setPolicyPresets(workspacePath, {
    presets: ['GitHub', 'github', 'NPM'],
    rules: [
      {
        action: 'allow',
        host: 'api.github.com',
        port: 443,
        methods: ['GET'],
        paths: ['/repos/**'],
        agent: '*',
        managedByPreset: 'GitHub',
      },
    ],
  });

  expect(state.presets).toEqual(['github', 'npm']);
  expect(state.rules).toEqual([
    expect.objectContaining({
      host: 'api.github.com',
      methods: ['GET'],
      paths: ['/repos/**'],
      managedByPreset: 'github',
    }),
  ]);
  expect(readPolicyDocument(workspacePath).network).toMatchObject({
    presets: ['github', 'npm'],
    rules: [
      expect.objectContaining({
        host: 'api.github.com',
        managed_by_preset: 'github',
      }),
    ],
  });
  expect(readPolicyState(workspacePath).rules).toEqual([
    expect.objectContaining({
      host: 'api.github.com',
      managedByPreset: 'github',
    }),
  ]);
});

test('updates an existing rule by index and clears preset provenance', () => {
  const workspacePath = makeWorkspace();
  setPolicyPresets(workspacePath, {
    presets: ['github'],
    rules: [
      {
        action: 'allow',
        host: 'api.github.com',
        port: 443,
        methods: ['GET'],
        paths: ['/repos/**'],
        agent: '*',
        managedByPreset: 'github',
      },
    ],
  });

  const state = updatePolicyRule(workspacePath, 1, {
    action: 'deny',
    host: 'api.github.com',
    port: '*',
    methods: ['POST'],
    paths: ['/repos/private/**'],
    agent: 'main',
    comment: 'Manual override',
  });

  expect(state.rules).toEqual([
    expect.objectContaining({
      index: 1,
      action: 'deny',
      host: 'api.github.com',
      port: '*',
      methods: ['POST'],
      paths: ['/repos/private/**'],
      agent: 'main',
      comment: 'Manual override',
    }),
  ]);
  expect(state.rules[0]?.managedByPreset).toBeUndefined();

  const network = readPolicyDocument(workspacePath).network as {
    rules?: Array<Record<string, unknown>>;
  };
  expect(network.rules?.[0]).not.toHaveProperty('managed_by_preset');
});
