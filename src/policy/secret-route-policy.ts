import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';
import {
  isGoogleOAuthSecretRef,
  type RuntimeHttpRequestAuthRuleSecret,
} from '../config/runtime-config.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import type { SecretRef } from '../security/secret-refs.js';
import { resolveWorkspacePolicyPath } from './policy-store.js';

const GOOGLE_WORKSPACE_CLI_TOKEN_SECRET = 'GOOGLE_WORKSPACE_CLI_TOKEN';
const MANAGED_BY_SECRET_ROUTE_FIELD = 'managed_by_secret_route';

type SecretRoutePolicyTarget = {
  secretSource: 'env' | 'store';
  secretId: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function writeRawPolicyObject(
  policyPath: string,
  document: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, YAML.stringify(document), 'utf-8');
}

function routePolicyTarget(
  secret: RuntimeHttpRequestAuthRuleSecret,
): SecretRoutePolicyTarget | null {
  if (isGoogleOAuthSecretRef(secret)) {
    return {
      secretSource: 'env',
      secretId: GOOGLE_WORKSPACE_CLI_TOKEN_SECRET,
    };
  }
  if (
    secret &&
    typeof secret === 'object' &&
    !Array.isArray(secret) &&
    (secret as SecretRef).source === 'store' &&
    typeof (secret as SecretRef).id === 'string'
  ) {
    return {
      secretSource: 'store',
      secretId: (secret as SecretRef).id,
    };
  }
  return null;
}

function secretRouteRuleId(params: {
  agentId: string;
  host: string;
  header: string;
  target: SecretRoutePolicyTarget;
}): string {
  const hash = createHash('sha256')
    .update(
      [
        params.agentId,
        params.host.toLowerCase(),
        params.header.toLowerCase(),
        params.target.secretSource,
        params.target.secretId,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 16);
  return `allow-http-secret-route-${hash}`;
}

function secretRouteRule(params: {
  agentId: string;
  host: string;
  header: string;
  target: SecretRoutePolicyTarget;
}): Record<string, unknown> {
  return {
    id: secretRouteRuleId(params),
    [MANAGED_BY_SECRET_ROUTE_FIELD]: true,
    when: {
      predicate: 'secret_resolve_allowed',
      id: params.target.secretId,
      source: params.target.secretSource,
      sink: 'http',
      host: params.host,
      selector: params.header,
      agent: params.agentId,
    },
    action: 'allow',
  };
}

export function allowHttpSecretRouteInWorkspacePolicy(params: {
  workspacePath: string;
  urlPrefix: string;
  header: string;
  secret: RuntimeHttpRequestAuthRuleSecret;
  agentId?: string;
}): string | null {
  const target = routePolicyTarget(params.secret);
  if (!target) return null;

  const host = new URL(params.urlPrefix).hostname;
  const agentId = params.agentId || DEFAULT_AGENT_ID;
  const policyPath = resolveWorkspacePolicyPath(params.workspacePath);
  const document = readRawPolicyObject(policyPath);
  const secret = asRecord(document.secret);
  const rules = Array.isArray(secret.rules) ? [...secret.rules] : [];
  const nextRule = secretRouteRule({
    agentId,
    host,
    header: params.header,
    target,
  });
  const nextRuleId = String(nextRule.id);
  const nextRules = rules.filter(
    (rule) => asRecord(rule).id !== nextRuleId,
  );
  nextRules.push(nextRule);
  document.secret = {
    ...secret,
    rules: nextRules,
  };
  writeRawPolicyObject(policyPath, document);
  return nextRuleId;
}

export function removeHttpSecretRouteFromWorkspacePolicy(params: {
  workspacePath: string;
  urlPrefix: string;
  header: string;
  secret: RuntimeHttpRequestAuthRuleSecret;
  agentId?: string;
}): boolean {
  const target = routePolicyTarget(params.secret);
  if (!target) return false;

  const host = new URL(params.urlPrefix).hostname;
  const agentId = params.agentId || DEFAULT_AGENT_ID;
  const policyPath = resolveWorkspacePolicyPath(params.workspacePath);
  const document = readRawPolicyObject(policyPath);
  const secret = asRecord(document.secret);
  const rules = Array.isArray(secret.rules) ? [...secret.rules] : [];
  const ruleId = secretRouteRuleId({
    agentId,
    host,
    header: params.header,
    target,
  });
  const nextRules = rules.filter((rule) => asRecord(rule).id !== ruleId);
  if (nextRules.length === rules.length) return false;
  document.secret = {
    ...secret,
    rules: nextRules,
  };
  writeRawPolicyObject(policyPath, document);
  return true;
}
