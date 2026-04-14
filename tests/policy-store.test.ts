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
      host: 'hybridclaw.io',
      port: 443,
      methods: ['*'],
      paths: ['/**'],
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
    expect.objectContaining({ host: 'hybridclaw.io' }),
  ]);

  state = resetPolicyNetwork(workspacePath);
  expect(state.defaultAction).toBe('deny');
  expect(state.presets).toEqual([]);
  expect(state.rules).toEqual([
    expect.objectContaining({
      host: 'hybridclaw.io',
      action: 'allow',
      methods: ['*'],
      paths: ['/**'],
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
