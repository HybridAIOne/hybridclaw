import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import {
  isRuntimeSecretName,
  readStoredRuntimeSecret,
} from '../security/runtime-secrets.js';
import type { SecretSinkKind } from '../security/secret-handles.js';
import { rememberResolvedSecretForLeakScan } from '../security/secret-leak-corpus.js';
import {
  evaluateSecretPolicyAccess,
  readWorkspaceSecretPolicyState,
} from '../security/secret-policy.js';
import { parseSessionKey } from '../session/session-key.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';

type ApiSecretInjectBody = {
  secretName?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
  skillName?: unknown;
  sinkKind?: unknown;
  host?: unknown;
  selector?: unknown;
};

function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

export function resolveSecretAgentId(params: {
  sessionId?: string;
  agentId?: string;
}): string {
  const explicit = normalizeString(params.agentId);
  if (explicit) return explicit;
  const parsed = parseSessionKey(normalizeString(params.sessionId));
  return parsed?.agentId || DEFAULT_AGENT_ID;
}

export function assertSecretResolveAllowed(params: {
  sessionId?: string;
  agentId?: string;
  skillName?: string;
  secretSource: 'env' | 'store';
  secretId: string;
  sinkKind: SecretSinkKind;
  host?: string;
  selector?: string;
}): void {
  const agentId = resolveSecretAgentId(params);
  const workspacePath = agentWorkspaceDir(agentId);
  const state = readWorkspaceSecretPolicyState(workspacePath);
  const evaluation = evaluateSecretPolicyAccess({
    state,
    context: {
      agentId,
      skillName: params.skillName,
      secretSource: params.secretSource,
      secretId: params.secretId,
      sinkKind: params.sinkKind,
      host: params.host,
      selector: params.selector,
    },
  });
  if (evaluation.decision === 'allow') return;
  throw new GatewayRequestError(
    403,
    `Secret ${params.secretSource}:${params.secretId} is blocked by secret resolution policy.`,
  );
}

export function recordSecretResolved(params: {
  sessionId?: string;
  runId?: string;
  skillName?: string;
  secretSource: 'env' | 'store';
  secretId: string;
  sinkKind: SecretSinkKind;
  host?: string;
  selector?: string;
}): void {
  const sessionId = normalizeString(params.sessionId) || 'secret-resolution';
  recordAuditEvent({
    sessionId,
    runId: params.runId || makeAuditRunId('secret'),
    event: {
      type: 'secret.resolved',
      skill: normalizeString(params.skillName) || null,
      secretRef: {
        source: params.secretSource,
        id: params.secretId,
      },
      sinkKind: params.sinkKind,
      host: normalizeString(params.host) || null,
      selector: normalizeString(params.selector) || null,
    },
  });
}

export function recordSecretUnsafeEscaped(params: {
  sessionId?: string;
  runId?: string;
  skillName?: string;
  secretSource: 'env' | 'store';
  secretId: string;
  sinkKind: SecretSinkKind;
  host?: string;
  selector?: string;
  reason: string;
}): void {
  const sessionId = normalizeString(params.sessionId) || 'secret-resolution';
  recordAuditEvent({
    sessionId,
    runId: params.runId || makeAuditRunId('secret-escape'),
    event: {
      type: 'secret.unsafe_escape',
      skill: normalizeString(params.skillName) || null,
      secretRef: {
        source: params.secretSource,
        id: params.secretId,
      },
      sinkKind: params.sinkKind,
      host: normalizeString(params.host) || null,
      selector: normalizeString(params.selector) || null,
      reason: params.reason,
    },
  });
}

export function resolveStoredSecretForInjection(params: {
  secretName: string;
  sessionId?: string;
  agentId?: string;
  skillName?: string;
  sinkKind: SecretSinkKind;
  host?: string;
  selector?: string;
}): string {
  const secretName = normalizeString(params.secretName);
  if (!isRuntimeSecretName(secretName)) {
    throw new GatewayRequestError(400, `Invalid secret name: ${secretName}`);
  }
  assertSecretResolveAllowed({
    sessionId: params.sessionId,
    agentId: params.agentId,
    skillName: params.skillName,
    secretSource: 'store',
    secretId: secretName,
    sinkKind: params.sinkKind,
    host: params.host,
    selector: params.selector,
  });
  const value = readStoredRuntimeSecret(secretName);
  if (!value) {
    throw new GatewayRequestError(
      400,
      `Stored secret ${secretName} is not set.`,
    );
  }
  recordSecretResolved({
    sessionId: params.sessionId,
    skillName: params.skillName,
    secretSource: 'store',
    secretId: secretName,
    sinkKind: params.sinkKind,
    host: params.host,
    selector: params.selector,
  });
  recordSecretUnsafeEscaped({
    sessionId: params.sessionId,
    skillName: params.skillName,
    secretSource: 'store',
    secretId: secretName,
    sinkKind: params.sinkKind,
    host: params.host,
    selector: params.selector,
    reason: `inject ${secretName} into ${params.sinkKind} sink`,
  });
  rememberResolvedSecretForLeakScan({
    sessionId: normalizeString(params.sessionId) || 'secret-resolution',
    secretId: secretName,
    value,
  });
  return value;
}

export async function handleApiSecretInject(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiSecretInjectBody;
  const secretName = normalizeString(body.secretName);
  const sinkKindInput = normalizeString(body.sinkKind).toLowerCase();
  if (sinkKindInput && sinkKindInput !== 'dom') {
    throw new GatewayRequestError(
      400,
      '`/api/secret/inject` only supports DOM injection.',
    );
  }
  const value = resolveStoredSecretForInjection({
    secretName,
    sessionId: normalizeString(body.sessionId),
    agentId: normalizeString(body.agentId),
    skillName: normalizeString(body.skillName),
    sinkKind: 'dom',
    host: normalizeString(body.host),
    selector: normalizeString(body.selector),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  // This local gateway-to-container endpoint intentionally carries cleartext.
  sendJson(res, 200, {
    ok: true,
    secretName,
    value,
  });
}
