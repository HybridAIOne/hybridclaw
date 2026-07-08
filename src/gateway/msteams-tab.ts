import {
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';
import type { RuntimeConfig } from '../config/runtime-config.js';

export const TEAMS_TAB_SCOPE = 'access_as_user';
export const TEAMS_DESKTOP_CLIENT_ID = '1fec8e78-bce4-4aaf-ab1b-5451cc387264';
export const TEAMS_WEB_CLIENT_ID = '5e3ce6c0-2b1f-4285-8d4b-75ee78787346';
export const TEAMS_APP_ENTITY_ID = 'hybridclaw-hub';
export const TEAMS_JS_SDK_URL =
  'https://res.cdn.office.net/teams-js/2.0.0/js/MicrosoftTeams.min.js';

export const TEAMS_FRAME_ANCESTORS = [
  'https://teams.microsoft.com',
  'https://*.teams.microsoft.com',
  'https://*.skype.com',
  'https://*.office.com',
  'https://*.office.net',
  'https://*.microsoft.com',
] as const;

const jwksCache = new Map<string, JWTVerifyGetKey>();

export interface MSTeamsTabSsoConfig {
  enabled: boolean;
  tenantId: string;
  ssoAppId: string;
  appIdUri: string;
  allowFrom: string[];
}

export interface MSTeamsTabViewer {
  sub: string;
  email?: string;
  name?: string;
}

export interface ValidateMSTeamsTabTokenOptions {
  tenantId: string;
  ssoAppId: string;
  appIdUri: string;
  allowFrom?: string[];
  now?: Date;
  jwks?: JWTVerifyGetKey;
}

export class MSTeamsTabTokenError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MSTeamsTabTokenError';
    this.code = code;
  }
}

function normalizeNonEmpty(value: string | null | undefined): string {
  return String(value || '').trim();
}

export function resolveMSTeamsTabConfig(
  config: RuntimeConfig,
  publicOrigin?: string | null,
): MSTeamsTabSsoConfig {
  const ssoAppId =
    normalizeNonEmpty(config.msteams.tab.ssoAppId) ||
    normalizeNonEmpty(config.msteams.appId);
  let appIdUri = normalizeNonEmpty(config.msteams.tab.appIdUri);
  if (!appIdUri && publicOrigin && ssoAppId) {
    appIdUri = `api://${new URL(publicOrigin).host}/${ssoAppId}`;
  }
  return {
    enabled: config.msteams.tab.enabled,
    tenantId: normalizeNonEmpty(config.msteams.tenantId),
    ssoAppId,
    appIdUri,
    allowFrom: config.msteams.tab.allowFrom.map((entry) => entry.trim()),
  };
}

function getEntraJwks(tenantId: string): JWTVerifyGetKey {
  const cached = jwksCache.get(tenantId);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(
    new URL(
      `https://login.microsoftonline.com/${encodeURIComponent(
        tenantId,
      )}/discovery/v2.0/keys`,
    ),
  );
  jwksCache.set(tenantId, jwks);
  return jwks;
}

function hasScope(scopeClaim: unknown, scope: string): boolean {
  if (typeof scopeClaim !== 'string') return false;
  return scopeClaim
    .split(/\s+/)
    .map((entry) => entry.trim())
    .includes(scope);
}

export function isMSTeamsTabViewerAllowed(
  viewer: MSTeamsTabViewer,
  allowFrom: string[],
): boolean {
  if (allowFrom.length === 0) return true;
  const allowed = new Set(
    allowFrom.map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  if (allowed.size === 0) return true;
  return [viewer.sub, viewer.email ?? ''].some((candidate) =>
    allowed.has(candidate.trim().toLowerCase()),
  );
}

export async function validateMSTeamsTabIdToken(
  idToken: string,
  options: ValidateMSTeamsTabTokenOptions,
): Promise<MSTeamsTabViewer> {
  const token = idToken.trim();
  if (!token) {
    throw new MSTeamsTabTokenError('missing_token', 'ID token is required.');
  }
  const tenantId = normalizeNonEmpty(options.tenantId);
  const ssoAppId = normalizeNonEmpty(options.ssoAppId);
  const appIdUri = normalizeNonEmpty(options.appIdUri);
  if (!tenantId) {
    throw new MSTeamsTabTokenError(
      'missing_tenant',
      'Teams tenant ID is not configured.',
    );
  }
  if (!ssoAppId && !appIdUri) {
    throw new MSTeamsTabTokenError(
      'missing_audience',
      'Teams SSO app ID or App ID URI is not configured.',
    );
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(
      token,
      options.jwks ?? getEntraJwks(tenantId),
      {
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        audience: [appIdUri, ssoAppId].filter(Boolean),
        currentDate: options.now,
      },
    );
    payload = verified.payload;
  } catch (error) {
    throw new MSTeamsTabTokenError(
      'invalid_token',
      error instanceof Error ? error.message : 'Invalid ID token.',
    );
  }

  if (payload.tid !== tenantId) {
    throw new MSTeamsTabTokenError('wrong_tenant', 'ID token tenant mismatch.');
  }
  if (!hasScope(payload.scp, TEAMS_TAB_SCOPE)) {
    throw new MSTeamsTabTokenError(
      'missing_scope',
      'ID token is missing access_as_user scope.',
    );
  }
  const oid = normalizeNonEmpty(
    typeof payload.oid === 'string' ? payload.oid : '',
  );
  const preferredUsername = normalizeNonEmpty(
    typeof payload.preferred_username === 'string'
      ? payload.preferred_username
      : '',
  );
  if (!oid) {
    throw new MSTeamsTabTokenError('missing_oid', 'ID token oid is required.');
  }
  const name = normalizeNonEmpty(
    typeof payload.name === 'string' ? payload.name : '',
  );
  const viewer = {
    sub: oid,
    ...(preferredUsername ? { email: preferredUsername } : {}),
    ...(name ? { name } : {}),
  };
  if (!isMSTeamsTabViewerAllowed(viewer, options.allowFrom ?? [])) {
    throw new MSTeamsTabTokenError(
      'viewer_denied',
      'Viewer is not allowed for this publication.',
    );
  }
  return viewer;
}
