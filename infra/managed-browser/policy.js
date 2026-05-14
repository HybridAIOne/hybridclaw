import fs from 'node:fs';
import YAML from 'yaml';
import {
  asRecord,
  evaluateNetworkPolicyAccess,
  readNetworkPolicyState,
} from '../../container/shared/network-policy.js';

const POLICY_CACHE_TTL_MS = 10_000;
const policyCache = new Map();

export function readTenantPolicyFile(policyPath) {
  let parsed = {};
  try {
    const raw = fs.readFileSync(policyPath, 'utf-8');
    parsed = YAML.parse(raw) || {};
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const tenants = asRecord(asRecord(parsed).tenants);
  const out = new Map();
  for (const [tenantId, tenantConfig] of Object.entries(tenants)) {
    out.set(tenantId, readNetworkPolicyState(asRecord(tenantConfig)));
  }
  return out;
}

export function readCachedTenantPolicyFile(policyPath, nowMs = Date.now()) {
  const cached = policyCache.get(policyPath);
  if (cached && nowMs - cached.loadedAtMs < POLICY_CACHE_TTL_MS) {
    return cached.tenants;
  }
  const tenants = readTenantPolicyFile(policyPath);
  policyCache.set(policyPath, { loadedAtMs: nowMs, tenants });
  return tenants;
}

export function evaluateTenantNavigation(params) {
  const parsed = new URL(params.url);
  const port =
    parsed.port === ''
      ? parsed.protocol === 'https:'
        ? 443
        : 80
      : Number.parseInt(parsed.port, 10);
  const tenants = readCachedTenantPolicyFile(params.policyPath);
  const tenantPolicy = tenants.get(params.tenantId) || {
    defaultAction: 'deny',
    rules: [],
  };
  const context = {
    host: parsed.hostname,
    port,
    method:
      String(params.method || '')
        .trim()
        .toUpperCase() || 'GET',
    path: `${parsed.pathname || '/'}${parsed.search || ''}`,
    agentId: params.agentId,
  };
  const own = evaluateNetworkPolicyAccess({
    rules: tenantPolicy.rules,
    defaultAction: tenantPolicy.defaultAction,
    ...context,
  });
  if (own.decision === 'allow') {
    return {
      verdict: 'allow',
      url: parsed.toString(),
      reason: null,
      matchedRule: own.matchedRule || null,
    };
  }

  for (const [otherTenantId, otherPolicy] of tenants.entries()) {
    if (otherTenantId === params.tenantId) continue;
    const other = evaluateNetworkPolicyAccess({
      rules: otherPolicy.rules,
      defaultAction: 'deny',
      ...context,
    });
    if (other.decision === 'allow') {
      return {
        verdict: 'deny',
        url: parsed.toString(),
        reason: `URL is in another tenant allowlist scope (${otherTenantId})`,
        matchedRule: other.matchedRule || null,
      };
    }
  }

  return {
    verdict: 'deny',
    url: parsed.toString(),
    reason: 'host is not allowed for this tenant',
    matchedRule: own.matchedRule || null,
  };
}
