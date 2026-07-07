import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  ADMIN_TOKEN_RBAC_ACTIONS,
  type AdminRbacAction,
  isAdminActionAllowed,
} from '../security/admin-rbac.js';
import {
  type ApiTokenMetadata,
  createApiToken,
  listApiTokens,
  normalizeApiTokenClaims,
  revokeApiToken,
} from '../security/api-tokens.js';

export interface GatewayAdminTokensResponse {
  tokens: ApiTokenMetadata[];
  total: number;
  actions: AdminRbacAction[];
}

export interface GatewayAdminTokenCreateResponse {
  token: string;
  apiToken: ApiTokenMetadata;
}

export interface GatewayAdminTokenRevokeResponse {
  apiToken: ApiTokenMetadata;
}

export interface AdminTokenAuditContext {
  sessionId?: string;
  actor?: string | null;
  sourceIp?: string | null;
}

function resolveAllowedAdminTokenActions(
  authPayload: Record<string, unknown> | null,
): AdminRbacAction[] {
  return ADMIN_TOKEN_RBAC_ACTIONS.filter((action) =>
    isAdminActionAllowed(authPayload, action),
  );
}

function resolveAuditSessionId(audit: AdminTokenAuditContext): string {
  return audit.sessionId || audit.actor || 'admin:anonymous';
}

function recordTokenAudit(params: {
  type: 'token.created' | 'token.revoked';
  audit: AdminTokenAuditContext;
  token: ApiTokenMetadata;
}): void {
  recordAuditEvent({
    sessionId: resolveAuditSessionId(params.audit),
    runId: makeAuditRunId(
      params.type === 'token.created' ? 'token-create' : 'token-revoke',
    ),
    event: {
      type: params.type,
      id: params.token.id,
      label: params.token.label,
      claims: params.token.claims,
      actor: params.audit.actor || null,
      sourceIp: params.audit.sourceIp || null,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeStringArrayClaim(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
  ) {
    return value.map((entry) => entry.trim()).filter(Boolean);
  }
  throw new GatewayRequestError(400, `\`${field}\` must be a string or array.`);
}

function buildClaimsFromBody(body: Record<string, unknown>) {
  if (isRecord(body.claims)) {
    return normalizeApiTokenClaims(body.claims);
  }

  const claims: Record<string, unknown> = {};
  const actions = normalizeStringArrayClaim(body.actions, 'actions');
  const scope = normalizeStringArrayClaim(body.scope, 'scope');
  const roles = normalizeStringArrayClaim(body.roles, 'roles');
  const role =
    typeof body.role === 'string' && body.role.trim()
      ? body.role.trim()
      : undefined;

  if (actions !== undefined) claims.actions = actions;
  if (scope !== undefined) claims.scope = scope.join(' ');
  if (roles !== undefined) claims.roles = roles;
  if (role !== undefined) claims.role = role;

  if (
    !Object.hasOwn(claims, 'actions') &&
    !Object.hasOwn(claims, 'scope') &&
    !Object.hasOwn(claims, 'role') &&
    !Object.hasOwn(claims, 'roles')
  ) {
    throw new GatewayRequestError(
      400,
      'API token claims are required. Provide `actions`, `scope`, `role`, `roles`, or `claims`.',
    );
  }

  return normalizeApiTokenClaims(claims);
}

function normalizeCreateBody(body: unknown): {
  label: string;
  claims: Record<string, unknown>;
  expiresAt: string | null;
} {
  if (!isRecord(body)) {
    throw new GatewayRequestError(400, 'Request body must be an object.');
  }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) {
    throw new GatewayRequestError(400, '`label` is required.');
  }
  const expiresAt =
    typeof body.expiresAt === 'string' && body.expiresAt.trim()
      ? body.expiresAt.trim()
      : null;
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
    throw new GatewayRequestError(400, '`expiresAt` must be a valid date.');
  }
  return {
    label,
    claims: buildClaimsFromBody(body),
    expiresAt,
  };
}

export function getGatewayAdminTokens(options: {
  authPayload: Record<string, unknown> | null;
}): GatewayAdminTokensResponse {
  const tokens = listApiTokens();
  return {
    tokens,
    total: tokens.length,
    actions: resolveAllowedAdminTokenActions(options.authPayload),
  };
}

export function createGatewayAdminToken(options: {
  body: unknown;
  audit: AdminTokenAuditContext;
}): GatewayAdminTokenCreateResponse {
  const body = normalizeCreateBody(options.body);
  const result = createApiToken({
    label: body.label,
    claims: body.claims,
    expiresAt: body.expiresAt,
    createdBy: options.audit.actor || null,
  });
  recordTokenAudit({
    type: 'token.created',
    audit: options.audit,
    token: result.metadata,
  });
  return {
    token: result.token,
    apiToken: result.metadata,
  };
}

export function revokeGatewayAdminToken(options: {
  id: string;
  audit: AdminTokenAuditContext;
}): GatewayAdminTokenRevokeResponse {
  const token = revokeApiToken(options.id);
  if (!token) {
    throw new GatewayRequestError(404, 'API token not found.');
  }
  recordTokenAudit({
    type: 'token.revoked',
    audit: options.audit,
    token,
  });
  return { apiToken: token };
}
