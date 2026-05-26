import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';
import {
  asRecord,
  DEFAULT_NETWORK_DEFAULT,
  DEFAULT_NETWORK_RULES,
  type NetworkPolicyAction,
  type NetworkRule,
  normalizeNetworkRule,
  normalizePresetNames,
  readNetworkPolicyState,
} from './network-policy.js';

const MANAGED_BY_PRESET_FIELD = 'managed_by_preset';
const LAN_HTTP_ACCESS_MANAGED_PRESET = 'lan-http-access';
const LAN_HTTP_ACCESS_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const;
const LAN_READ_ONLY_METHODS = ['GET'] as const;
const LAN_READ_WRITE_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

export type LanHttpAccessMode = 'off' | 'read-only' | 'read-write' | 'custom';

export interface LanHttpAccessState {
  mode: LanHttpAccessMode;
  managedRuleIndexes: number[];
}

export interface ManagedNetworkRule extends NetworkRule {
  managedByPreset?: string;
}

export interface IndexedNetworkRule extends ManagedNetworkRule {
  index: number;
}

export interface PolicyNetworkState {
  exists: boolean;
  policyPath: string;
  workspacePath: string;
  defaultAction: NetworkPolicyAction;
  presets: string[];
  rules: IndexedNetworkRule[];
  lanHttpAccess: LanHttpAccessState;
}

function parseIpv4Address(value: string): number | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const octets = value.split('.').map((entry) => Number.parseInt(entry, 10));
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  );
}

function isPrivateLanHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if ((LAN_HTTP_ACCESS_RANGES as readonly string[]).includes(normalized)) {
    return true;
  }
  const address = parseIpv4Address(normalized);
  if (address == null) return false;
  return (
    (address & 0xff000000) >>> 0 === 0x0a000000 ||
    (address & 0xfff00000) >>> 0 === 0xac100000 ||
    (address & 0xffff0000) >>> 0 === 0xc0a80000
  );
}

function sameMethods(actual: string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((method) => actual.includes(method));
}

function isManagedLanRuleForMode(
  rule: IndexedNetworkRule,
  mode: Exclude<LanHttpAccessMode, 'off' | 'custom'>,
): boolean {
  const expectedMethods =
    mode === 'read-only' ? LAN_READ_ONLY_METHODS : LAN_READ_WRITE_METHODS;
  return (
    rule.action === 'allow' &&
    rule.managedByPreset === LAN_HTTP_ACCESS_MANAGED_PRESET &&
    (LAN_HTTP_ACCESS_RANGES as readonly string[]).includes(rule.host) &&
    rule.port === '*' &&
    sameMethods(rule.methods, expectedMethods) &&
    rule.paths.length === 1 &&
    rule.paths[0] === '/**' &&
    rule.agent === '*'
  );
}

function deriveLanHttpAccess(rules: IndexedNetworkRule[]): LanHttpAccessState {
  const managedRules = rules.filter(
    (rule) => rule.managedByPreset === LAN_HTTP_ACCESS_MANAGED_PRESET,
  );
  const managedRuleIndexes = managedRules.map((rule) => rule.index);
  const hasCustomLanRule = rules.some(
    (rule) =>
      rule.action === 'allow' &&
      rule.managedByPreset !== LAN_HTTP_ACCESS_MANAGED_PRESET &&
      isPrivateLanHost(rule.host),
  );

  if (managedRules.length === 0) {
    return {
      mode: hasCustomLanRule ? 'custom' : 'off',
      managedRuleIndexes,
    };
  }

  const managedHosts = new Set(managedRules.map((rule) => rule.host));
  const hasExpectedHosts = LAN_HTTP_ACCESS_RANGES.every((range) =>
    managedHosts.has(range),
  );
  const hasOnlyExpectedHosts = managedRules.every((rule) =>
    (LAN_HTTP_ACCESS_RANGES as readonly string[]).includes(rule.host),
  );
  if (
    managedRules.length === LAN_HTTP_ACCESS_RANGES.length &&
    !hasCustomLanRule &&
    hasExpectedHosts &&
    hasOnlyExpectedHosts &&
    managedRules.every((rule) => isManagedLanRuleForMode(rule, 'read-only'))
  ) {
    return { mode: 'read-only', managedRuleIndexes };
  }
  if (
    managedRules.length === LAN_HTTP_ACCESS_RANGES.length &&
    !hasCustomLanRule &&
    hasExpectedHosts &&
    hasOnlyExpectedHosts &&
    managedRules.every((rule) => isManagedLanRuleForMode(rule, 'read-write'))
  ) {
    return { mode: 'read-write', managedRuleIndexes };
  }
  return { mode: 'custom', managedRuleIndexes };
}

function buildManagedLanRules(
  mode: Exclude<LanHttpAccessMode, 'off' | 'custom'>,
): ManagedNetworkRule[] {
  const methods =
    mode === 'read-only' ? LAN_READ_ONLY_METHODS : LAN_READ_WRITE_METHODS;
  const label = mode === 'read-only' ? 'read-only' : 'read-write';
  return LAN_HTTP_ACCESS_RANGES.map((host) => ({
    action: 'allow',
    host,
    port: '*',
    methods: [...methods],
    paths: ['/**'],
    agent: '*',
    comment: `Managed RFC1918 LAN HTTP ${label}`,
    managedByPreset: LAN_HTTP_ACCESS_MANAGED_PRESET,
  }));
}

function normalizeManagedByPreset(value: unknown): string | undefined {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

function validateWritableRule(rule: NetworkRule): ManagedNetworkRule {
  const normalized = normalizeNetworkRule(rule);
  if (normalized) return normalized;
  const host = String(rule.host || '').trim();
  if (!host) {
    throw new Error('Policy rule is missing a host.');
  }
  throw new Error('Policy rule has an invalid port.');
}

function normalizeManagedRuleOrThrow(
  rule: ManagedNetworkRule,
  index: number,
): ManagedNetworkRule {
  const normalized = normalizeNetworkRule(rule);
  if (!normalized) {
    const host = String(rule.host || '').trim();
    if (!host) {
      throw new Error(`Policy rule #${index} is missing a host.`);
    }
    throw new Error(`Policy rule #${index} has an invalid port.`);
  }
  const managedByPreset = normalizeManagedByPreset(rule.managedByPreset);
  return {
    ...normalized,
    ...(managedByPreset ? { managedByPreset } : {}),
  };
}

function toYamlNetworkRule(rule: ManagedNetworkRule): Record<string, unknown> {
  return {
    action: rule.action,
    host: rule.host,
    ...(rule.port === '*' ? {} : { port: rule.port }),
    methods: [...rule.methods],
    paths: [...rule.paths],
    agent: rule.agent,
    ...(rule.comment ? { comment: rule.comment } : {}),
    ...(rule.managedByPreset
      ? { [MANAGED_BY_PRESET_FIELD]: rule.managedByPreset }
      : {}),
  };
}

function readRawPolicyObject(policyPath: string): Record<string, unknown> {
  if (!fs.existsSync(policyPath)) return {};
  const raw = fs.readFileSync(policyPath, 'utf-8');
  const parsed = YAML.parse(raw) as unknown;
  if (!parsed) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Policy file must contain a YAML mapping: ${policyPath}`);
  }
  return parsed as Record<string, unknown>;
}

function buildWritablePolicyObject(params: {
  base: Record<string, unknown>;
  defaultAction: NetworkPolicyAction;
  rules: ManagedNetworkRule[];
  presets: string[];
}): Record<string, unknown> {
  const next = { ...params.base };
  const approval = asRecord(next.approval);
  delete approval.trusted_network_hosts;
  if (Object.keys(approval).length > 0) {
    next.approval = approval;
  } else {
    delete next.approval;
  }
  next.network = {
    default: params.defaultAction,
    rules: params.rules.map((rule) => toYamlNetworkRule(rule)),
    presets: [...params.presets],
  };
  if (Object.keys(asRecord(next.audit)).length === 0) {
    delete next.audit;
  }

  const ordered: Record<string, unknown> = {};
  if (next.approval) ordered.approval = next.approval;
  if (next.network) ordered.network = next.network;
  if (next.audit) ordered.audit = next.audit;
  for (const [key, value] of Object.entries(next)) {
    if (key === 'approval' || key === 'network' || key === 'audit') continue;
    ordered[key] = value;
  }
  return ordered;
}

function toPolicyState(
  policyPath: string,
  document: Record<string, unknown> = readRawPolicyObject(policyPath),
  exists: boolean = fs.existsSync(policyPath),
): PolicyNetworkState {
  const config = readNetworkPolicyState(document);
  const rawNetwork = asRecord(document.network);
  const rawRules = Array.isArray(rawNetwork.rules) ? rawNetwork.rules : null;
  const rules =
    rawRules !== null
      ? rawRules
          .map((entry) => {
            const rawRule = asRecord(entry);
            const normalized = normalizeNetworkRule(rawRule);
            const managedByPreset = normalizeManagedByPreset(
              rawRule[MANAGED_BY_PRESET_FIELD],
            );
            if (!normalized) return null;
            return {
              ...normalized,
              ...(managedByPreset ? { managedByPreset } : {}),
            } satisfies ManagedNetworkRule;
          })
          .filter((rule): rule is ManagedNetworkRule => Boolean(rule))
      : config.rules.map((rule) => ({ ...rule }));
  const workspacePath = path.dirname(path.dirname(policyPath));
  const indexedRules = rules.map((rule, index) => ({
    ...rule,
    index: index + 1,
  }));
  return {
    exists,
    policyPath,
    workspacePath,
    defaultAction: config.defaultAction,
    presets: [...config.presets],
    rules: indexedRules,
    lanHttpAccess: deriveLanHttpAccess(indexedRules),
  };
}

function assertWritablePolicyRules(
  document: Record<string, unknown>,
  policyPath: string,
): void {
  const rawNetwork = asRecord(document.network);
  const rawRules = Array.isArray(rawNetwork.rules) ? rawNetwork.rules : null;
  if (rawRules === null) return;
  const invalidIndex = rawRules.findIndex(
    (entry) => !normalizeNetworkRule(asRecord(entry)),
  );
  if (invalidIndex === -1) return;
  throw new Error(
    `Policy file contains an invalid network rule at index ${invalidIndex + 1}. Fix ${policyPath} before editing it.`,
  );
}

export function stripRuleIndex(rule: IndexedNetworkRule): ManagedNetworkRule {
  return {
    action: rule.action,
    host: rule.host,
    port: rule.port,
    methods: [...rule.methods],
    paths: [...rule.paths],
    agent: rule.agent,
    ...(rule.comment ? { comment: rule.comment } : {}),
    ...(rule.managedByPreset ? { managedByPreset: rule.managedByPreset } : {}),
  };
}

function writePolicyState(params: {
  policyPath: string;
  base: Record<string, unknown>;
  defaultAction: NetworkPolicyAction;
  rules: ManagedNetworkRule[];
  presets: string[];
}): void {
  const payload = buildWritablePolicyObject({
    base: params.base,
    defaultAction: params.defaultAction,
    rules: params.rules,
    presets: normalizePresetNames(params.presets),
  });
  fs.mkdirSync(path.dirname(params.policyPath), { recursive: true });
  fs.writeFileSync(params.policyPath, YAML.stringify(payload), 'utf-8');
}

function updatePolicyState(
  workspacePath: string,
  update: (draft: {
    defaultAction: NetworkPolicyAction;
    rules: ManagedNetworkRule[];
    presets: string[];
  }) => void,
): PolicyNetworkState {
  const policyPath = resolveWorkspacePolicyPath(workspacePath);
  const exists = fs.existsSync(policyPath);
  const base = readRawPolicyObject(policyPath);
  assertWritablePolicyRules(base, policyPath);
  const current = toPolicyState(policyPath, base, exists);
  const draft = {
    defaultAction: current.defaultAction,
    rules: current.rules.map((rule) => stripRuleIndex(rule)),
    presets: [...current.presets],
  };
  update(draft);
  const normalizedRules = draft.rules.map((rule, index) =>
    normalizeManagedRuleOrThrow(rule, index + 1),
  );
  writePolicyState({
    policyPath,
    base,
    defaultAction: draft.defaultAction === 'allow' ? 'allow' : 'deny',
    rules: normalizedRules,
    presets: draft.presets,
  });
  return toPolicyState(policyPath);
}

export function resolveWorkspacePolicyPath(workspacePath: string): string {
  return path.join(path.resolve(workspacePath), '.hybridclaw', 'policy.yaml');
}

export function readPolicyState(workspacePath: string): PolicyNetworkState {
  return toPolicyState(resolveWorkspacePolicyPath(workspacePath));
}

export function setPolicyDefault(
  workspacePath: string,
  defaultAction: NetworkPolicyAction,
): PolicyNetworkState {
  return updatePolicyState(workspacePath, (draft) => {
    draft.defaultAction = defaultAction;
  });
}

export function addPolicyRule(
  workspacePath: string,
  rule: NetworkRule,
): PolicyNetworkState {
  const normalized = validateWritableRule(rule);
  return updatePolicyState(workspacePath, (draft) => {
    draft.rules.push(normalized);
  });
}

export function updatePolicyRule(
  workspacePath: string,
  index: number,
  rule: NetworkRule,
): PolicyNetworkState {
  if (!Number.isInteger(index) || index <= 0) {
    throw new Error('Rule index must be a positive integer.');
  }
  const normalized = validateWritableRule(rule);
  const current = readPolicyState(workspacePath);
  if (!current.rules.some((entry) => entry.index === index)) {
    throw new Error(`No policy rule matched "${index}".`);
  }
  return updatePolicyState(workspacePath, (draft) => {
    draft.rules = current.rules.map((entry) =>
      entry.index === index ? normalized : stripRuleIndex(entry),
    );
  });
}

export function deletePolicyRule(
  workspacePath: string,
  target: string,
): { state: PolicyNetworkState; deleted: IndexedNetworkRule[] } {
  const current = readPolicyState(workspacePath);
  const rawTarget = target.trim();
  if (!rawTarget) {
    throw new Error('Rule index or host is required.');
  }
  const numericTarget = Number.parseInt(rawTarget, 10);
  const deleted =
    Number.isFinite(numericTarget) && `${numericTarget}` === rawTarget
      ? current.rules.filter((rule) => rule.index === numericTarget)
      : current.rules.filter(
          (rule) => rule.host === rawTarget.toLowerCase().replace(/\.$/, ''),
        );
  if (deleted.length === 0) {
    throw new Error(`No policy rule matched "${target}".`);
  }
  const next = updatePolicyState(workspacePath, (draft) => {
    draft.rules = current.rules
      .filter((rule) => !deleted.some((entry) => entry.index === rule.index))
      .map((rule) => stripRuleIndex(rule));
  });
  return {
    state: next,
    deleted,
  };
}

export function resetPolicyNetwork(workspacePath: string): PolicyNetworkState {
  return updatePolicyState(workspacePath, (draft) => {
    draft.defaultAction = DEFAULT_NETWORK_DEFAULT;
    draft.rules = DEFAULT_NETWORK_RULES.map((rule) => ({
      ...rule,
      methods: [...rule.methods],
      paths: [...rule.paths],
    }));
    draft.presets = [];
  });
}

export function setPolicyPresets(
  workspacePath: string,
  params: {
    presets: string[];
    rules: ManagedNetworkRule[];
  },
): PolicyNetworkState {
  return updatePolicyState(workspacePath, (draft) => {
    draft.presets = [...params.presets];
    draft.rules = params.rules.map((rule) => ({ ...rule }));
  });
}

export function setLanHttpAccessMode(
  workspacePath: string,
  mode: LanHttpAccessMode,
): PolicyNetworkState {
  if (mode === 'custom') {
    return readPolicyState(workspacePath);
  }
  return updatePolicyState(workspacePath, (draft) => {
    draft.rules = draft.rules.filter(
      (rule) => rule.managedByPreset !== LAN_HTTP_ACCESS_MANAGED_PRESET,
    );
    if (mode === 'off') return;
    draft.rules.push(...buildManagedLanRules(mode));
  });
}
