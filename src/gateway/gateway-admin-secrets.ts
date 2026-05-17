import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  isRuntimeSecretName,
  listRuntimeSecretMetadata,
  type RuntimeSecretMetadataEntry,
} from '../security/runtime-secrets.js';

export interface GatewayAdminSecretsResponse {
  secrets: RuntimeSecretMetadataEntry[];
  total: number;
  filtered: number;
}

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

export function getGatewayAdminSecrets(options?: {
  canListSecret?: (name: string) => boolean;
  audit?: {
    sessionId?: string;
    actor?: string | null;
    sourceIp?: string | null;
  };
}): GatewayAdminSecretsResponse {
  const allSecrets = listRuntimeSecretMetadata({
    declaredNames: listDeclaredRuntimeSecretNames(),
  });
  const secrets = options?.canListSecret
    ? allSecrets.filter((entry) => options.canListSecret?.(entry.name))
    : allSecrets;
  const response = {
    secrets,
    total: allSecrets.length,
    filtered: allSecrets.length - secrets.length,
  };

  if (options?.audit) {
    recordAuditEvent({
      sessionId: options.audit.sessionId || 'admin:secrets',
      runId: makeAuditRunId('secret-metadata'),
      event: {
        type: 'secret.viewed_metadata',
        actor: options.audit.actor || null,
        sourceIp: options.audit.sourceIp || null,
        visibleCount: response.secrets.length,
        totalCount: response.total,
        filteredCount: response.filtered,
      },
    });
  }

  return response;
}
