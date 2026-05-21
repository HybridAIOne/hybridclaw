import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  isReservedNonSecretRuntimeName,
  isRuntimeSecretName,
  listRuntimeSecretMetadata,
  type RuntimeSecretMetadataEntry,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';

export interface GatewayAdminSecretsResponse {
  secrets: RuntimeSecretMetadataEntry[];
  total: number;
}

export interface GatewayAdminSecretMutationResponse {
  secret: RuntimeSecretMetadataEntry;
}

interface AdminSecretAuditContext {
  sessionId?: string;
  actor?: string | null;
  sourceIp?: string | null;
}

type AdminSecretMutationType = 'secret.overwritten' | 'secret.unset';

function isStoreSecretRef(value: unknown): value is {
  source: 'store';
  id: string;
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { source?: unknown }).source === 'store' &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

function collectStoreSecretRefNames(
  value: unknown,
  names: Set<string>,
  seen = new WeakSet<object>(),
): void {
  if (isStoreSecretRef(value)) {
    if (isRuntimeSecretName(value.id)) names.add(value.id);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectStoreSecretRefNames(entry, names, seen);
    return;
  }
  for (const entry of Object.values(value)) {
    collectStoreSecretRefNames(entry, names, seen);
  }
}

function listDeclaredRuntimeSecretNames(): string[] {
  const names = new Set<string>();
  collectStoreSecretRefNames(getRuntimeConfig(), names);
  return [...names].sort((left, right) => left.localeCompare(right));
}

function resolveAuditSessionId(audit: AdminSecretAuditContext): string {
  return audit.sessionId || audit.actor || 'admin:anonymous';
}

function recordSecretMutationAudit(params: {
  type: AdminSecretMutationType;
  audit: AdminSecretAuditContext;
  name: string;
  success: boolean;
  fingerprint: RuntimeSecretMetadataEntry['fingerprint'];
  errorCode?: string;
}): void {
  recordAuditEvent({
    sessionId: resolveAuditSessionId(params.audit),
    runId: makeAuditRunId(
      params.type === 'secret.overwritten'
        ? 'secret-overwrite'
        : 'secret-unset',
    ),
    event: {
      type: params.type,
      actor: params.audit.actor || null,
      sourceIp: params.audit.sourceIp || null,
      name: params.name,
      success: params.success,
      fingerprint: params.fingerprint,
      ...(params.errorCode ? { errorCode: params.errorCode } : {}),
    },
  });
}

function requireWritableSecretName(name: string): string {
  const normalized = name.trim();
  if (!isRuntimeSecretName(normalized)) {
    throw new GatewayRequestError(
      400,
      'Invalid secret name. Use uppercase letters, digits, and underscores only.',
    );
  }
  if (isReservedNonSecretRuntimeName(normalized)) {
    throw new GatewayRequestError(
      400,
      'Secret name is reserved for non-secret runtime config.',
    );
  }
  return normalized;
}

function requireSecretValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GatewayRequestError(400, 'Secret value is required.');
  }
  return value.trim();
}

function fallbackUnsetSecretMetadata(name: string): RuntimeSecretMetadataEntry {
  return {
    name,
    state: 'unset',
    created_at: null,
    last_rotated_at: null,
    fingerprint: null,
  };
}

function getRuntimeSecretMetadata(name: string): RuntimeSecretMetadataEntry {
  return (
    listRuntimeSecretMetadata({
      declaredNames: listDeclaredRuntimeSecretNames(),
    }).find((entry) => entry.name === name) || fallbackUnsetSecretMetadata(name)
  );
}

export function getGatewayAdminSecrets(options: {
  audit: AdminSecretAuditContext;
}): GatewayAdminSecretsResponse {
  const secrets = listRuntimeSecretMetadata({
    declaredNames: listDeclaredRuntimeSecretNames(),
  });
  const response = {
    secrets,
    total: secrets.length,
  };

  recordAuditEvent({
    sessionId: resolveAuditSessionId(options.audit),
    runId: makeAuditRunId('secret-metadata'),
    event: {
      type: 'secret.viewed_metadata',
      actor: options.audit.actor || null,
      sourceIp: options.audit.sourceIp || null,
      visibleCount: response.secrets.length,
      totalCount: response.total,
    },
  });

  return response;
}

export function recordGatewayAdminSecretMutationDenied(options: {
  type: AdminSecretMutationType;
  name: string;
  audit: AdminSecretAuditContext;
  errorCode: 'forbidden';
}): void {
  recordGatewayAdminSecretMutationFailure(options);
}

export function recordGatewayAdminSecretMutationFailure(options: {
  type: AdminSecretMutationType;
  name: string;
  audit: AdminSecretAuditContext;
  errorCode: 'bad_request' | 'forbidden' | 'unauthorized' | 'write_failed';
}): void {
  recordSecretMutationAudit({
    type: options.type,
    audit: options.audit,
    name: options.name.trim(),
    success: false,
    fingerprint: null,
    errorCode: options.errorCode,
  });
}

export function overwriteGatewayAdminSecret(options: {
  name: string;
  value: unknown;
  audit: AdminSecretAuditContext;
}): GatewayAdminSecretMutationResponse {
  let name = options.name.trim();
  try {
    name = requireWritableSecretName(options.name);
    const value = requireSecretValue(options.value);
    saveNamedRuntimeSecrets({ [name]: value });
    const secret = getRuntimeSecretMetadata(name);
    recordSecretMutationAudit({
      type: 'secret.overwritten',
      audit: options.audit,
      name,
      success: true,
      fingerprint: secret.fingerprint,
    });
    return { secret };
  } catch (error) {
    recordSecretMutationAudit({
      type: 'secret.overwritten',
      audit: options.audit,
      name,
      success: false,
      fingerprint: null,
      errorCode:
        error instanceof GatewayRequestError ? 'bad_request' : 'write_failed',
    });
    throw error;
  }
}

export function unsetGatewayAdminSecret(options: {
  name: string;
  audit: AdminSecretAuditContext;
}): GatewayAdminSecretMutationResponse {
  let name = options.name.trim();
  try {
    name = requireWritableSecretName(options.name);
    saveNamedRuntimeSecrets({ [name]: null });
    const secret = getRuntimeSecretMetadata(name);
    recordSecretMutationAudit({
      type: 'secret.unset',
      audit: options.audit,
      name,
      success: true,
      fingerprint: null,
    });
    return { secret };
  } catch (error) {
    recordSecretMutationAudit({
      type: 'secret.unset',
      audit: options.audit,
      name,
      success: false,
      fingerprint: null,
      errorCode:
        error instanceof GatewayRequestError ? 'bad_request' : 'write_failed',
    });
    throw error;
  }
}
