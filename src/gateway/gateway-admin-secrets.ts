import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  type AdminRbacAction,
  isAdminActionAllowed,
} from '../security/admin-rbac.js';
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
  /**
   * Admin actions the requester is allowed to perform on this surface.
   * The client uses this to render write affordances only when the
   * caller can use them (spec: buttons absent, not just disabled).
   */
  actions: AdminRbacAction[];
}

export interface GatewayAdminSecretMutationResponse {
  secret: RuntimeSecretMetadataEntry;
}

export interface AdminSecretAuditContext {
  sessionId?: string;
  actor?: string | null;
  sourceIp?: string | null;
}

const ADMIN_SECRET_ACTIONS: ReadonlyArray<AdminRbacAction> = [
  'secret.list_metadata',
  'secret.overwrite',
  'secret.unset',
];

function resolveAllowedAdminSecretActions(
  sessionPayload: Record<string, unknown> | null,
): AdminRbacAction[] {
  return ADMIN_SECRET_ACTIONS.filter((action) =>
    isAdminActionAllowed(sessionPayload, action),
  );
}

export type AdminSecretMutationType = 'secret.overwritten' | 'secret.unset';

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
    length: null,
    fingerprint: null,
  };
}

function getRuntimeSecretMetadata(name: string): RuntimeSecretMetadataEntry {
  return (
    listRuntimeSecretMetadata({
      declaredNames: [name],
    }).find((entry) => entry.name === name) || fallbackUnsetSecretMetadata(name)
  );
}

export function getGatewayAdminSecrets(options: {
  audit: AdminSecretAuditContext;
  sessionPayload: Record<string, unknown> | null;
}): GatewayAdminSecretsResponse {
  const secrets = listRuntimeSecretMetadata({
    declaredNames: listDeclaredRuntimeSecretNames(),
  });
  const response: GatewayAdminSecretsResponse = {
    secrets,
    total: secrets.length,
    actions: resolveAllowedAdminSecretActions(options.sessionPayload),
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

function errorCodeForSecretMutation(
  error: unknown,
): 'bad_request' | 'write_failed' {
  return error instanceof GatewayRequestError ? 'bad_request' : 'write_failed';
}

function withSecretMutationAudit<T>(
  type: AdminSecretMutationType,
  rawName: string,
  audit: AdminSecretAuditContext,
  run: (rawName: string) => {
    fingerprint: RuntimeSecretMetadataEntry['fingerprint'];
    name: string;
    response: T;
  },
): T {
  let auditName = rawName;
  try {
    const result = run(rawName);
    auditName = result.name;
    recordSecretMutationAudit({
      type,
      audit,
      name: result.name,
      success: true,
      fingerprint: result.fingerprint,
    });
    return result.response;
  } catch (error) {
    recordSecretMutationAudit({
      type,
      audit,
      name: auditName,
      success: false,
      fingerprint: null,
      errorCode: errorCodeForSecretMutation(error),
    });
    throw error;
  }
}

export function overwriteGatewayAdminSecret(options: {
  name: string;
  value: unknown;
  audit: AdminSecretAuditContext;
}): GatewayAdminSecretMutationResponse {
  return withSecretMutationAudit(
    'secret.overwritten',
    options.name,
    options.audit,
    (rawName) => {
      const name = requireWritableSecretName(rawName);
      const value = requireSecretValue(options.value);
      saveNamedRuntimeSecrets({ [name]: value });
      const secret = getRuntimeSecretMetadata(name);
      return {
        fingerprint: secret.fingerprint,
        name,
        response: { secret },
      };
    },
  );
}

export function unsetGatewayAdminSecret(options: {
  name: string;
  audit: AdminSecretAuditContext;
}): GatewayAdminSecretMutationResponse {
  return withSecretMutationAudit(
    'secret.unset',
    options.name,
    options.audit,
    (rawName) => {
      const name = requireWritableSecretName(rawName);
      saveNamedRuntimeSecrets({ [name]: null });
      const secret = getRuntimeSecretMetadata(name);
      return {
        fingerprint: null,
        name,
        response: { secret },
      };
    },
  );
}
