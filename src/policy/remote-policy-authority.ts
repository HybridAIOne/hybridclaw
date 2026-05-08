import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getRuntimeAssetRevision,
  listRuntimeAssetRevisionStates,
  listRuntimeAssetRevisions,
  restoreRuntimeAssetRevision,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import {
  asRecord,
  type NetworkPolicyAction,
  type NetworkRule,
  normalizeNetworkRule,
} from './network-policy.js';
import {
  type ManagedNetworkRule,
  readPolicyState,
  resolveWorkspacePolicyPath,
  stripRuleIndex,
} from './policy-store.js';

export type PolicyUpdateIngestMode = 'apply' | 'quarantine' | 'disabled';
export type PolicyUpdateDisposition =
  | 'applied'
  | 'quarantined'
  | 'rejected'
  | 'unchanged';
export type PolicyAuthorityKind = 'platform' | 'org_admin' | 'security_team';

export interface PolicyUpdatePrincipal {
  peerId: string;
  senderAgentId: string;
  policyAuthority?: PolicyAuthorityKind;
  capabilities: string[];
}

export interface PolicyUpdateResult {
  disposition: PolicyUpdateDisposition;
  updateId: string;
  diff: string[];
  statusCode?: number;
  pendingId?: string;
  revisionChanged?: boolean;
  reason?: string;
}

export interface ApprovalRule {
  pattern?: string;
  paths?: string[];
  tools?: string[];
}

interface PolicyView {
  pinnedRed: ApprovalRule[];
  networkDefault: NetworkPolicyAction;
  networkRules: ManagedNetworkRule[];
  networkPresets: string[];
  autonomyDefault: string;
  autonomyTools: Record<string, string>;
  autonomyActions: Record<string, string>;
  fullAutoNeverApprove: string[];
}

interface ParsedPolicyUpdate {
  updateId: string;
  reason: string;
  operations: PolicyUpdateOperation[];
}

export type PolicyUpdateOperation =
  | { kind: 'pinned_red.add'; rule: ApprovalRule }
  | { kind: 'pinned_red.remove'; rule: ApprovalRule }
  | { kind: 'allowlist.add'; rule: NetworkRule }
  | { kind: 'allowlist.remove'; host: string }
  | {
      kind: 'autonomy.tool.set' | 'autonomy.action.set';
      key: string;
      level: string;
    }
  | { kind: 'autonomy.tool.remove' | 'autonomy.action.remove'; key: string }
  | { kind: 'full_auto.never_approve.add'; value: string }
  | { kind: 'full_auto.never_approve.remove'; value: string };

export interface PendingPolicyUpdate {
  schemaVersion: 1;
  pendingId: string;
  updateId: string;
  reason: string;
  workspacePath: string;
  policyPath: string;
  principal: PolicyUpdatePrincipal;
  operations: PolicyUpdateOperation[];
  diff: string[];
  createdAt: string;
}

const DEFAULT_PINNED_RED: ApprovalRule[] = [
  { pattern: 'rm\\s+-rf\\s+/' },
  { paths: ['~/.ssh/**', '/etc/**', '.env*'] },
  { tools: ['force_push'] },
];
const DEFAULT_AUTONOMY_LEVEL = 'full-autonomous';
const POLICY_UPDATE_CAPABILITY = 'policy_write';
const POLICY_AUTHORITY_KINDS = new Set<PolicyAuthorityKind>([
  'platform',
  'org_admin',
  'security_team',
]);
const PENDING_POLICY_UPDATE_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'policy',
  'pending',
);
const AUTONOMY_LEVELS = new Set([
  'full-autonomous',
  'low-stakes-autonomous',
  'confirm-each',
]);

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry ?? null)).join(',')}]`;
  }
  if (typeof value !== 'object') return 'null';
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pendingPolicyUpdatePath(pendingId: string): string {
  return path.join(PENDING_POLICY_UPDATE_PREFIX, `${pendingId}.json`);
}

function readPolicyDocument(policyPath: string): Record<string, unknown> {
  if (!fs.existsSync(policyPath)) return {};
  const raw = fs.readFileSync(policyPath, 'utf-8');
  const parsed = YAML.parse(raw) as unknown;
  if (!parsed) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Policy file must contain a YAML mapping: ${policyPath}`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeApprovalRule(raw: unknown): ApprovalRule | null {
  const rule = asRecord(raw);
  const pattern = String(rule.pattern || '').trim();
  const paths = normalizeStringList(rule.paths);
  const tools = normalizeStringList(rule.tools);
  if (!pattern && paths.length === 0 && tools.length === 0) return null;
  return {
    ...(pattern ? { pattern } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function normalizeAutonomyLevel(raw: unknown): string {
  const level = String(raw || '')
    .trim()
    .toLowerCase();
  if (!AUTONOMY_LEVELS.has(level)) {
    throw new Error(
      `Invalid autonomy level "${String(raw)}". Use full-autonomous, low-stakes-autonomous, or confirm-each.`,
    );
  }
  return level;
}

function normalizeKey(raw: unknown, label: string): string {
  const key = String(raw || '')
    .trim()
    .toLowerCase();
  if (!key) throw new Error(`${label} is required.`);
  return key;
}

function normalizeNeverApproveValue(raw: unknown): string {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value) throw new Error('full-auto exclusion value is required.');
  return value;
}

function normalizeCapabilities(capabilities: string[]): string[] {
  return [
    ...new Set(
      capabilities
        .map((capability) => capability.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
}

function readRemoteUpdateMode(
  document: Record<string, unknown>,
): PolicyUpdateIngestMode {
  const remoteUpdates = asRecord(document.remote_updates);
  const mode = String(remoteUpdates.mode || '')
    .trim()
    .toLowerCase();
  if (mode === 'apply' || mode === 'quarantine' || mode === 'disabled') {
    return mode;
  }
  return 'quarantine';
}

function readAutonomyMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(asRecord(raw))) {
    const key = rawKey.trim().toLowerCase();
    const value = String(rawValue || '')
      .trim()
      .toLowerCase();
    if (!key || !AUTONOMY_LEVELS.has(value)) continue;
    out[key] = value;
  }
  return out;
}

function assertWritableNetworkRules(document: Record<string, unknown>): void {
  const rules = asRecord(document.network).rules;
  if (!Array.isArray(rules)) return;
  const invalidIndex = rules.findIndex(
    (rule) => !normalizeNetworkRule(asRecord(rule)),
  );
  if (invalidIndex >= 0) {
    throw new Error(
      `Policy file contains an invalid network rule at index ${invalidIndex + 1}. Fix it before applying remote updates.`,
    );
  }
}

function readPolicyView(
  workspacePath: string,
  document = readPolicyDocument(resolveWorkspacePolicyPath(workspacePath)),
): PolicyView {
  assertWritableNetworkRules(document);
  const approval = asRecord(document.approval);
  const autonomy = asRecord(document.autonomy);
  const fullAuto = asRecord(document.full_auto);
  const pinnedRed = Array.isArray(approval.pinned_red)
    ? approval.pinned_red
        .map((rule) => normalizeApprovalRule(rule))
        .filter((rule): rule is ApprovalRule => Boolean(rule))
    : DEFAULT_PINNED_RED.map((rule) => ({ ...rule }));
  const networkState = readPolicyState(workspacePath);
  return {
    pinnedRed,
    networkDefault: networkState.defaultAction,
    networkRules: networkState.rules.map((rule) => stripRuleIndex(rule)),
    networkPresets: [...networkState.presets],
    autonomyDefault: AUTONOMY_LEVELS.has(
      String(autonomy.default || '')
        .trim()
        .toLowerCase(),
    )
      ? String(autonomy.default || '')
          .trim()
          .toLowerCase()
      : DEFAULT_AUTONOMY_LEVEL,
    autonomyTools: readAutonomyMap(autonomy.tools),
    autonomyActions: readAutonomyMap(autonomy.actions),
    fullAutoNeverApprove: normalizeStringList(fullAuto.never_approve).map(
      (value) => value.toLowerCase(),
    ),
  };
}

function approvalRuleKey(rule: ApprovalRule): string {
  return stableJson({
    pattern: rule.pattern || '',
    paths: [...(rule.paths || [])].sort(),
    tools: [...(rule.tools || [])].sort(),
  });
}

function networkRuleKey(rule: Partial<NetworkRule> & { host: string }): string {
  return stableJson({
    action: rule.action || 'allow',
    host: rule.host,
    port: rule.port ?? '*',
    methods: [...(rule.methods || ['*'])].sort(),
    paths: [...(rule.paths || ['/**'])].sort(),
    agent: rule.agent || '*',
  });
}

function dedupeApprovalRules(rules: ApprovalRule[]): ApprovalRule[] {
  const seen = new Set<string>();
  const out: ApprovalRule[] = [];
  for (const rule of rules) {
    const key = approvalRuleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

function dedupeStrings(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}

function normalizeAllowRule(raw: Record<string, unknown>): NetworkRule {
  const candidate = normalizeNetworkRule({
    ...raw,
    action: 'allow',
    host: raw.host,
    port: raw.port ?? '*',
    methods: normalizeStringList(raw.methods).length
      ? normalizeStringList(raw.methods)
      : ['*'],
    paths: normalizeStringList(raw.paths).length
      ? normalizeStringList(raw.paths)
      : ['/**'],
    agent: String(raw.agent || '*'),
  });
  if (!candidate)
    throw new Error('allowlist rule has an invalid host or port.');
  return candidate;
}

function parsePolicyUpdateOperation(raw: unknown): PolicyUpdateOperation {
  const record = asRecord(raw);
  const kind = String(record.kind || record.op || '')
    .trim()
    .toLowerCase();
  if (kind === 'pinned_red.add') {
    const rule = normalizeApprovalRule(record.rule || record);
    if (!rule)
      throw new Error(
        'pinned_red.add requires a pattern, paths, or tools rule.',
      );
    return { kind, rule };
  }
  if (kind === 'pinned_red.remove') {
    const rule = normalizeApprovalRule(record.rule || record);
    if (!rule)
      throw new Error(
        'pinned_red.remove requires a pattern, paths, or tools rule.',
      );
    return { kind, rule };
  }
  if (
    kind === 'allowlist.add' ||
    kind === 'network.allow.add' ||
    kind === 'network.allowlist.add'
  ) {
    return {
      kind: 'allowlist.add',
      rule: normalizeAllowRule(asRecord(record.rule || record)),
    };
  }
  if (
    kind === 'allowlist.remove' ||
    kind === 'network.allow.remove' ||
    kind === 'network.allowlist.remove'
  ) {
    const rawRule = asRecord(record.rule || record);
    const host = String(rawRule.host || '').trim();
    if (!host) throw new Error('allowlist.remove requires a host.');
    const normalized = normalizeAllowRule({ host });
    return { kind: 'allowlist.remove', host: normalized.host };
  }
  if (kind === 'autonomy.tool.set' || kind === 'autonomy.actions.tool.set') {
    return {
      kind: 'autonomy.tool.set',
      key: normalizeKey(record.tool || record.key, 'tool'),
      level: normalizeAutonomyLevel(record.level),
    };
  }
  if (kind === 'autonomy.action.set') {
    return {
      kind,
      key: normalizeKey(record.action || record.key, 'action'),
      level: normalizeAutonomyLevel(record.level),
    };
  }
  if (kind === 'autonomy.tool.remove') {
    return {
      kind,
      key: normalizeKey(record.tool || record.key, 'tool'),
    };
  }
  if (kind === 'autonomy.action.remove') {
    return {
      kind,
      key: normalizeKey(record.action || record.key, 'action'),
    };
  }
  if (
    kind === 'full_auto.never_approve.add' ||
    kind === 'fullauto.never_approve.add'
  ) {
    return {
      kind: 'full_auto.never_approve.add',
      value: normalizeNeverApproveValue(
        record.value || record.tool || record.action,
      ),
    };
  }
  if (
    kind === 'full_auto.never_approve.remove' ||
    kind === 'fullauto.never_approve.remove'
  ) {
    return {
      kind: 'full_auto.never_approve.remove',
      value: normalizeNeverApproveValue(
        record.value || record.tool || record.action,
      ),
    };
  }
  throw new Error(
    `Unsupported policy update operation kind: ${kind || '(missing)'}.`,
  );
}

function parsePolicyUpdateContent(content: string): ParsedPolicyUpdate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `policy.update content must be JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = asRecord(parsed);
  const operations = Array.isArray(record.operations)
    ? record.operations.map((operation) =>
        parsePolicyUpdateOperation(operation),
      )
    : [];
  if (operations.length === 0) {
    throw new Error('policy.update content requires at least one operation.');
  }
  const updateId =
    String(record.update_id || record.updateId || '').trim() ||
    `policy-update-${sha256(stableJson(operations)).slice(0, 16)}`;
  return {
    updateId,
    reason: String(record.reason || '').trim(),
    operations,
  };
}

function applyOperation(
  view: PolicyView,
  operation: PolicyUpdateOperation,
): void {
  if (operation.kind === 'pinned_red.add') {
    view.pinnedRed = dedupeApprovalRules([...view.pinnedRed, operation.rule]);
    return;
  }
  if (operation.kind === 'pinned_red.remove') {
    const target = approvalRuleKey(operation.rule);
    view.pinnedRed = view.pinnedRed.filter(
      (rule) => approvalRuleKey(rule) !== target,
    );
    return;
  }
  if (operation.kind === 'allowlist.add') {
    const target = networkRuleKey(operation.rule);
    if (!view.networkRules.some((rule) => networkRuleKey(rule) === target)) {
      view.networkRules.push(operation.rule);
    }
    return;
  }
  if (operation.kind === 'allowlist.remove') {
    view.networkRules = view.networkRules.filter(
      (rule) => !(rule.action === 'allow' && rule.host === operation.host),
    );
    return;
  }
  if (operation.kind === 'autonomy.tool.set') {
    view.autonomyTools[operation.key] = operation.level;
    return;
  }
  if (operation.kind === 'autonomy.action.set') {
    view.autonomyActions[operation.key] = operation.level;
    return;
  }
  if (operation.kind === 'autonomy.tool.remove') {
    delete view.autonomyTools[operation.key];
    return;
  }
  if (operation.kind === 'autonomy.action.remove') {
    delete view.autonomyActions[operation.key];
    return;
  }
  if (operation.kind === 'full_auto.never_approve.add') {
    view.fullAutoNeverApprove = dedupeStrings([
      ...view.fullAutoNeverApprove,
      operation.value,
    ]);
    return;
  }
  if (operation.kind === 'full_auto.never_approve.remove') {
    view.fullAutoNeverApprove = view.fullAutoNeverApprove.filter(
      (value) => value !== operation.value,
    );
  }
}

function applyOperations(
  current: PolicyView,
  operations: PolicyUpdateOperation[],
): PolicyView {
  const next: PolicyView = {
    pinnedRed: current.pinnedRed.map((rule) => ({ ...rule })),
    networkDefault: current.networkDefault,
    networkRules: current.networkRules.map((rule) => ({ ...rule })),
    networkPresets: [...current.networkPresets],
    autonomyDefault: current.autonomyDefault,
    autonomyTools: { ...current.autonomyTools },
    autonomyActions: { ...current.autonomyActions },
    fullAutoNeverApprove: [...current.fullAutoNeverApprove],
  };
  for (const operation of operations) applyOperation(next, operation);
  return next;
}

function formatMapChanges(
  label: string,
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort();
  return keys
    .filter((key) => before[key] !== after[key])
    .map((key) => {
      if (before[key] === undefined)
        return `${label} added ${key}=${after[key]}`;
      if (after[key] === undefined) return `${label} removed ${key}`;
      return `${label} changed ${key}: ${before[key]} -> ${after[key]}`;
    });
}

function formatSetChanges(
  label: string,
  before: string[],
  after: string[],
): string[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...after
      .filter((entry) => !beforeSet.has(entry))
      .map((entry) => `${label} added ${entry}`),
    ...before
      .filter((entry) => !afterSet.has(entry))
      .map((entry) => `${label} removed ${entry}`),
  ];
}

function buildPolicyDiff(before: PolicyView, after: PolicyView): string[] {
  const beforePinned = before.pinnedRed.map((rule) => approvalRuleKey(rule));
  const afterPinned = after.pinnedRed.map((rule) => approvalRuleKey(rule));
  const beforeNetwork = before.networkRules.map((rule) => networkRuleKey(rule));
  const afterNetwork = after.networkRules.map((rule) => networkRuleKey(rule));
  return [
    ...formatSetChanges('pinned_red', beforePinned, afterPinned),
    ...formatSetChanges('allowlist', beforeNetwork, afterNetwork),
    ...formatMapChanges(
      'autonomy.tool',
      before.autonomyTools,
      after.autonomyTools,
    ),
    ...formatMapChanges(
      'autonomy.action',
      before.autonomyActions,
      after.autonomyActions,
    ),
    ...formatSetChanges(
      'full_auto.never_approve',
      before.fullAutoNeverApprove,
      after.fullAutoNeverApprove,
    ),
  ];
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
  };
}

function buildPolicyDocument(
  base: Record<string, unknown>,
  view: PolicyView,
): Record<string, unknown> {
  const next = { ...base };
  next.approval = {
    ...asRecord(next.approval),
    pinned_red: view.pinnedRed.map((rule) => ({ ...rule })),
  };
  next.network = {
    default: view.networkDefault,
    rules: view.networkRules.map((rule) => toYamlNetworkRule(rule)),
    presets: [...view.networkPresets],
  };
  next.autonomy = {
    default: view.autonomyDefault,
    tools: { ...view.autonomyTools },
    actions: { ...view.autonomyActions },
  };
  next.full_auto = {
    ...asRecord(next.full_auto),
    never_approve: [...view.fullAutoNeverApprove],
  };

  const ordered: Record<string, unknown> = {};
  for (const key of [
    'approval',
    'network',
    'autonomy',
    'full_auto',
    'remote_updates',
    'audit',
  ]) {
    if (next[key] !== undefined) ordered[key] = next[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (Object.hasOwn(ordered, key)) continue;
    ordered[key] = value;
  }
  return ordered;
}

function writePolicyDocument(
  policyPath: string,
  document: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, YAML.stringify(document), 'utf-8');
}

function syncPolicyRevision(
  policyPath: string,
  principal: PolicyUpdatePrincipal | null,
  route: string,
  observedContent?: string,
): ReturnType<typeof syncRuntimeAssetRevisionState> {
  return syncRuntimeAssetRevisionState(
    'policy',
    policyPath,
    {
      actor: principal?.senderAgentId || 'local-operator',
      route,
      source: principal ? `policy.update:${principal.peerId}` : 'policy-cli',
    },
    observedContent === undefined
      ? undefined
      : {
          exists: true,
          content: observedContent,
        },
  );
}

function syncPolicyBaseline(params: {
  policyPath: string;
  document: Record<string, unknown>;
  view: PolicyView;
  principal: PolicyUpdatePrincipal;
  route: string;
}): ReturnType<typeof syncRuntimeAssetRevisionState> {
  if (fs.existsSync(params.policyPath)) {
    return syncPolicyRevision(
      params.policyPath,
      params.principal,
      params.route,
    );
  }
  return syncPolicyRevision(
    params.policyPath,
    params.principal,
    params.route,
    YAML.stringify(buildPolicyDocument(params.document, params.view)),
  );
}

function hasPolicyWriteAuthority(principal: PolicyUpdatePrincipal): boolean {
  return (
    principal.capabilities.includes(POLICY_UPDATE_CAPABILITY) &&
    Boolean(
      principal.policyAuthority &&
        POLICY_AUTHORITY_KINDS.has(principal.policyAuthority),
    )
  );
}

function policyAuthorityRejectReason(principal: PolicyUpdatePrincipal): string {
  if (!principal.capabilities.includes(POLICY_UPDATE_CAPABILITY)) {
    return 'sender lacks policy_write capability';
  }
  return 'sender is not declared as a superior-rights policy authority';
}

function recordPolicyUpdatedAudit(params: {
  updateId: string;
  disposition: PolicyUpdateDisposition;
  principal?: PolicyUpdatePrincipal;
  diff: string[];
  revisionChanged?: boolean;
  pendingId?: string;
  statusCode?: number;
  reason?: string;
}): void {
  recordAuditEvent({
    sessionId: `policy:update:${params.updateId}`,
    runId: makeAuditRunId('policy-update'),
    event: {
      type: 'policy.updated',
      updateId: params.updateId,
      disposition: params.disposition,
      principal: params.principal || null,
      diff: params.diff,
      revisionChanged: params.revisionChanged ?? false,
      pendingId: params.pendingId || null,
      statusCode: params.statusCode || null,
      reason: params.reason || null,
    },
  });
}

function persistPendingPolicyUpdate(pending: PendingPolicyUpdate): void {
  syncRuntimeAssetRevisionState(
    'policy',
    pendingPolicyUpdatePath(pending.pendingId),
    {
      actor: pending.principal.senderAgentId,
      route: `policy.update.quarantine#${pending.updateId}`,
      source: `policy.update:${pending.principal.peerId}`,
    },
    {
      exists: true,
      content: JSON.stringify(pending),
    },
  );
}

function parsePendingPolicyUpdate(raw: string): PendingPolicyUpdate | null {
  try {
    const parsed = JSON.parse(raw) as PendingPolicyUpdate;
    if (parsed.schemaVersion !== 1) return null;
    if (
      !parsed.pendingId ||
      !parsed.updateId ||
      !Array.isArray(parsed.operations)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function listPendingPolicyUpdates(): PendingPolicyUpdate[] {
  return listRuntimeAssetRevisionStates('policy', {
    assetPathPrefix: PENDING_POLICY_UPDATE_PREFIX,
  })
    .map((state) => parsePendingPolicyUpdate(state.content))
    .filter((pending): pending is PendingPolicyUpdate => pending !== null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function loadPolicyFullAutoNeverApprove(
  workspacePath: string,
): string[] {
  try {
    return readPolicyView(workspacePath).fullAutoNeverApprove;
  } catch {
    return [];
  }
}

export function handleRemotePolicyUpdate(params: {
  workspacePath: string;
  content: string;
  principal: PolicyUpdatePrincipal;
  forcedMode?: PolicyUpdateIngestMode;
}): PolicyUpdateResult {
  const capabilities = normalizeCapabilities(params.principal.capabilities);
  const principal = {
    ...params.principal,
    capabilities,
  };
  let parsed: ParsedPolicyUpdate;
  try {
    parsed = parsePolicyUpdateContent(params.content);
  } catch (error) {
    const result: PolicyUpdateResult = {
      disposition: 'rejected',
      updateId: `invalid-${sha256(params.content).slice(0, 16)}`,
      diff: [],
      statusCode: 400,
      reason: error instanceof Error ? error.message : String(error),
    };
    recordPolicyUpdatedAudit({ ...result, principal });
    return result;
  }
  if (!hasPolicyWriteAuthority(principal)) {
    const result: PolicyUpdateResult = {
      disposition: 'rejected',
      updateId: parsed.updateId,
      diff: [],
      statusCode: 403,
      reason: policyAuthorityRejectReason(principal),
    };
    recordPolicyUpdatedAudit({ ...result, principal });
    return result;
  }

  try {
    const policyPath = resolveWorkspacePolicyPath(params.workspacePath);
    const document = readPolicyDocument(policyPath);
    const mode = params.forcedMode || readRemoteUpdateMode(document);

    if (mode === 'disabled') {
      const result: PolicyUpdateResult = {
        disposition: 'rejected',
        updateId: parsed.updateId,
        diff: [],
        statusCode: 403,
        reason: 'policy.update ingest is disabled',
      };
      recordPolicyUpdatedAudit({ ...result, principal });
      return result;
    }

    const before = readPolicyView(params.workspacePath, document);
    const after = applyOperations(before, parsed.operations);
    const diff = buildPolicyDiff(before, after);
    if (diff.length === 0) {
      const result: PolicyUpdateResult = {
        disposition: 'unchanged',
        updateId: parsed.updateId,
        diff,
        reason: 'policy update produced no changes',
      };
      recordPolicyUpdatedAudit({ ...result, principal });
      return result;
    }

    if (mode === 'quarantine') {
      const pendingId = `${Date.now()}-${randomUUID()}`;
      persistPendingPolicyUpdate({
        schemaVersion: 1,
        pendingId,
        updateId: parsed.updateId,
        reason: parsed.reason,
        workspacePath: path.resolve(params.workspacePath),
        policyPath,
        principal,
        operations: parsed.operations,
        diff,
        createdAt: new Date().toISOString(),
      });
      const result: PolicyUpdateResult = {
        disposition: 'quarantined',
        updateId: parsed.updateId,
        diff,
        pendingId,
      };
      recordPolicyUpdatedAudit({ ...result, principal, reason: parsed.reason });
      return result;
    }

    syncPolicyBaseline({
      policyPath,
      document,
      view: before,
      principal,
      route: `policy.update.preflight#${parsed.updateId}`,
    });
    writePolicyDocument(policyPath, buildPolicyDocument(document, after));
    const revision = syncPolicyRevision(
      policyPath,
      principal,
      `policy.update.apply#${parsed.updateId}`,
    );
    const result: PolicyUpdateResult = {
      disposition: 'applied',
      updateId: parsed.updateId,
      diff,
      revisionChanged: revision.changed,
    };
    recordPolicyUpdatedAudit({ ...result, principal, reason: parsed.reason });
    return result;
  } catch (error) {
    const result: PolicyUpdateResult = {
      disposition: 'rejected',
      updateId: parsed.updateId,
      diff: [],
      statusCode: 500,
      reason: error instanceof Error ? error.message : String(error),
    };
    recordPolicyUpdatedAudit({ ...result, principal, reason: parsed.reason });
    return result;
  }
}

export function acceptPendingPolicyUpdate(
  pendingId: string,
  workspacePath: string,
): PolicyUpdateResult {
  const pending = listPendingPolicyUpdates().find(
    (entry) => entry.pendingId === pendingId || entry.updateId === pendingId,
  );
  if (!pending)
    throw new Error(`Pending policy update not found: ${pendingId}`);
  const content = JSON.stringify({
    update_id: pending.updateId,
    reason: pending.reason,
    operations: pending.operations,
  });
  const result = handleRemotePolicyUpdate({
    workspacePath,
    content,
    principal: pending.principal,
    forcedMode: 'apply',
  });
  if (result.disposition === 'applied' || result.disposition === 'unchanged') {
    syncRuntimeAssetRevisionState(
      'policy',
      pendingPolicyUpdatePath(pending.pendingId),
      {
        actor: 'local-operator',
        route: `policy.update.accept-pending#${pending.pendingId}`,
        source: 'policy-cli',
      },
      { exists: false, content: null },
    );
  }
  return {
    ...result,
    pendingId: pending.pendingId,
  };
}

export function formatPolicyUpdateResult(result: PolicyUpdateResult): string {
  return [
    `Policy update ${result.updateId}: ${result.disposition}`,
    ...(result.pendingId ? [`Pending id: ${result.pendingId}`] : []),
    ...(result.reason ? [`Reason: ${result.reason}`] : []),
    ...(result.diff.length > 0
      ? ['Diff:', ...result.diff.map((line) => `  - ${line}`)]
      : ['Diff: (none)']),
  ].join('\n');
}

export function formatPendingPolicyUpdateDiff(pendingId?: string): string {
  const pendingUpdates = listPendingPolicyUpdates();
  const pending = pendingId
    ? pendingUpdates.find(
        (entry) =>
          entry.pendingId === pendingId || entry.updateId === pendingId,
      )
    : pendingUpdates.length === 1
      ? pendingUpdates[0]
      : null;
  if (!pending) {
    if (pendingUpdates.length === 0) return 'No pending policy updates.';
    return [
      'Pending policy updates:',
      ...pendingUpdates.map(
        (entry) =>
          `${entry.pendingId} update=${entry.updateId} from=${entry.principal.senderAgentId}`,
      ),
    ].join('\n');
  }
  return [
    `Pending policy update ${pending.pendingId}`,
    `Update: ${pending.updateId}`,
    `From: ${pending.principal.senderAgentId}`,
    ...(pending.reason ? [`Reason: ${pending.reason}`] : []),
    'Diff:',
    ...pending.diff.map((line) => `  - ${line}`),
  ].join('\n');
}

export function listPolicyRevisions(workspacePath: string) {
  return listRuntimeAssetRevisions(
    'policy',
    resolveWorkspacePolicyPath(workspacePath),
  );
}

export function rollbackPolicyRevision(
  workspacePath: string,
  revisionId: number,
): string {
  const policyPath = resolveWorkspacePolicyPath(workspacePath);
  const revision = getRuntimeAssetRevision('policy', policyPath, revisionId);
  if (!revision)
    throw new Error(`Policy revision ${revisionId} was not found.`);
  restoreRuntimeAssetRevision('policy', policyPath, revisionId, {
    actor: 'local-operator',
    route: `policy.rollback#${revisionId}`,
    source: 'policy-cli',
  });
  recordPolicyUpdatedAudit({
    updateId: `rollback-${revisionId}`,
    disposition: 'applied',
    diff: [`rolled back to revision #${revisionId}`],
    revisionChanged: true,
    reason: 'local rollback',
  });
  return `Rolled back policy to revision #${revisionId}.`;
}
