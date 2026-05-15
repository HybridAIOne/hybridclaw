import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { DATA_DIR } from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { readPolicyState } from '../policy/policy-store.js';

export interface ManagedBrowserTenantPolicySyncResult {
  tenantId: string;
  policyPath: string;
  agentIds: string[];
  ruleCount: number;
}

type TenantPolicyDocument = {
  tenants?: Record<string, TenantPolicyEntry>;
};

type TenantPolicyEntry = {
  network?: {
    default?: string;
    rules?: TenantPolicyRule[];
  };
};

type TenantPolicyRule = {
  action?: string;
  host?: string;
  port?: number | string;
  methods?: string[];
  paths?: string[];
  agent?: string;
  comment?: string;
};

type ProjectedAgentPolicy = {
  defaultAction: string;
  rules: TenantPolicyRule[];
};

export function resolveLocalManagedBrowserTenantPolicyPath(
  dataDir = DATA_DIR,
): string {
  return path.join(dataDir, 'managed-browser', 'tenants.yaml');
}

export function ensureLocalManagedBrowserTenantPolicyFile(
  params: { dataDir?: string } = {},
): string {
  const policyPath = resolveLocalManagedBrowserTenantPolicyPath(params.dataDir);
  if (fs.existsSync(policyPath)) return policyPath;
  fs.mkdirSync(path.dirname(policyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(policyPath, YAML.stringify({ tenants: {} }), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return policyPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readPolicyDocument(policyPath: string): TenantPolicyDocument {
  if (!fs.existsSync(policyPath)) return { tenants: {} };
  const parsed = YAML.parse(fs.readFileSync(policyPath, 'utf-8'));
  if (!isRecord(parsed)) return { tenants: {} };
  const tenants = isRecord(parsed.tenants) ? parsed.tenants : {};
  return {
    ...parsed,
    tenants: Object.fromEntries(
      Object.entries(tenants).map(([tenantId, tenant]) => [
        tenantId,
        isRecord(tenant) ? (tenant as TenantPolicyEntry) : {},
      ]),
    ),
  };
}

function normalizeTenantPolicyRule(rule: TenantPolicyRule): TenantPolicyRule {
  return {
    action: String(rule.action || 'allow')
      .trim()
      .toLowerCase(),
    host: String(rule.host || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, ''),
    port: rule.port ?? '*',
    methods:
      Array.isArray(rule.methods) && rule.methods.length > 0
        ? rule.methods
            .map((method) => String(method || '').trim())
            .filter(Boolean)
        : ['*'],
    paths:
      Array.isArray(rule.paths) && rule.paths.length > 0
        ? rule.paths.map((entry) => String(entry || '').trim()).filter(Boolean)
        : ['/**'],
    agent:
      String(rule.agent || '*')
        .trim()
        .toLowerCase() || '*',
    ...(rule.comment ? { comment: String(rule.comment) } : {}),
  };
}

function ruleKey(rule: TenantPolicyRule): string {
  const normalized = normalizeTenantPolicyRule(rule);
  return JSON.stringify({
    action: normalized.action,
    host: normalized.host,
    port: normalized.port,
    methods: normalized.methods,
    paths: normalized.paths,
    agent: normalized.agent,
  });
}

function uniqueRules(rules: TenantPolicyRule[]): TenantPolicyRule[] {
  return [
    ...new Map(
      rules
        .map((rule) => normalizeTenantPolicyRule(rule))
        .filter((rule) => rule.host)
        .map((rule) => [ruleKey(rule), rule] as const),
    ).values(),
  ];
}

function managedBrowserTenantId(rawTenantId?: string): string {
  return (
    rawTenantId?.trim() ||
    getRuntimeConfig().browser.managedCloud.defaultTenantId.trim() ||
    DEFAULT_AGENT_ID
  );
}

function managedBrowserPolicyAgentIds(): string[] {
  return [
    ...new Set([
      DEFAULT_AGENT_ID,
      ...(getRuntimeConfig().agents?.list ?? []).map((agent) =>
        agent.id.trim(),
      ),
    ]),
  ].filter(Boolean);
}

function projectAgentPolicy(
  agentId: string,
  resolveWorkspacePath: (agentId: string) => string,
): ProjectedAgentPolicy {
  const state = readPolicyState(resolveWorkspacePath(agentId));
  return {
    defaultAction: state.defaultAction,
    rules: uniqueRules(
      state.rules.map((rule) => ({
        action: rule.action,
        host: rule.host,
        port: rule.port,
        methods: rule.methods,
        paths: rule.paths,
        agent: rule.agent === '*' ? agentId : rule.agent,
        ...(rule.comment ? { comment: rule.comment } : {}),
      })),
    ),
  };
}

export function syncLocalManagedBrowserTenantPolicyFromAdminPolicies(
  params: {
    tenantId?: string;
    agentIds?: string[];
    dataDir?: string;
    resolveWorkspacePath?: (agentId: string) => string;
  } = {},
): ManagedBrowserTenantPolicySyncResult {
  const tenantId = managedBrowserTenantId(params.tenantId);
  const agentIds = [
    ...new Set(
      (params.agentIds?.length
        ? params.agentIds
        : managedBrowserPolicyAgentIds()
      )
        .map((agentId) => agentId.trim())
        .filter(Boolean),
    ),
  ];
  const resolveWorkspacePath = params.resolveWorkspacePath ?? agentWorkspaceDir;
  const policyPath = ensureLocalManagedBrowserTenantPolicyFile({
    dataDir: params.dataDir,
  });
  const document = readPolicyDocument(policyPath);
  const projectedByAgent = new Map<string, ProjectedAgentPolicy>();

  for (const agentId of agentIds) {
    try {
      projectedByAgent.set(
        agentId,
        projectAgentPolicy(agentId, resolveWorkspacePath),
      );
    } catch {
      projectedByAgent.set(agentId, {
        defaultAction: 'deny',
        rules: [],
      });
    }
  }

  const sharedRules = uniqueRules(
    [...projectedByAgent.values()].flatMap((policy) => policy.rules),
  );
  document.tenants = {};
  document.tenants[tenantId] = {
    network: {
      default: 'deny',
      rules: sharedRules,
    },
  };

  for (const [agentId, policy] of projectedByAgent) {
    if (agentId === tenantId) continue;
    document.tenants[agentId] = {
      network: {
        default: policy.defaultAction,
        rules: policy.rules,
      },
    };
  }

  fs.writeFileSync(policyPath, YAML.stringify(document), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return {
    tenantId,
    policyPath,
    agentIds,
    ruleCount: sharedRules.length,
  };
}
