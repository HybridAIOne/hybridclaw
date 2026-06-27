import { randomBytes } from 'node:crypto';

import {
  buildGoogleAuthorizeUrl,
  clearGoogleAuth,
  DEFAULT_GOOGLE_OAUTH_SCOPES,
  exchangeGoogleAuthorizationCode,
  GOOGLE_ACCOUNT_SECRET,
  GOOGLE_OAUTH_CLIENT_ID_SECRET,
  GOOGLE_OAUTH_CLIENT_SECRET_SECRET,
  GOOGLE_OAUTH_SCOPES_SECRET,
  getGoogleAuthStatus,
  loginGoogle,
  parseGoogleScopes,
} from '../auth/google-auth.js';
import {
  clearHybridAICredentials,
  getHybridAIApiKey,
  getHybridAIAuthStatus,
} from '../auth/hybridai-auth.js';
import {
  buildMicrosoft365AuthorizeUrl,
  clearMicrosoft365Auth,
  createMicrosoft365PkcePair,
  DEFAULT_MICROSOFT_365_OAUTH_SCOPES,
  exchangeMicrosoft365AuthorizationCode,
  getMicrosoft365AuthStatus,
  loginMicrosoft365,
  MICROSOFT_365_ACCOUNT_SECRET,
  MICROSOFT_365_OAUTH_CLIENT_ID_SECRET,
  MICROSOFT_365_OAUTH_CLIENT_SECRET_SECRET,
  MICROSOFT_365_OAUTH_SCOPES_SECRET,
  MICROSOFT_365_TENANT_ID_SECRET,
  parseMicrosoft365Scopes,
} from '../auth/microsoft-auth.js';
import {
  HYBRIDAI_BASE_URL,
  MissingRequiredEnvVarError,
  refreshRuntimeSecretsFromEnv,
} from '../config/config.js';
import {
  getRuntimeConfig,
  isGoogleOAuthSecretRef,
  isMicrosoftOAuthSecretRef,
  makeGoogleOAuthSecretRef,
  makeMicrosoftOAuthSecretRef,
  normalizeHttpRequestAuthRuleUrlPrefix,
  type RuntimeHttpRequestAuthRule,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  readStoredRuntimeSecret,
  runtimeSecretsPath,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';

const PENDING_CONNECTOR_OAUTH_TTL_MS = 10 * 60_000;
const HYBRIDAI_LOGIN_PATH = '/login?context=hybridclaw&next=/admin_api_keys';
const HYBRIDAI_CONNECTORS_PATH = '/admin_workspace/connectors';

export type GatewayAdminConnectorId =
  | 'hybridai'
  | 'github'
  | 'google'
  | 'microsoft365';
export type GatewayAdminLocalOAuthConnectorId = Extract<
  GatewayAdminConnectorId,
  'google' | 'microsoft365'
>;
export type GatewayAdminOAuthConnectorId = Exclude<
  GatewayAdminConnectorId,
  'hybridai'
>;

export type GatewayAdminConnectorState =
  | 'connected'
  | 'not_connected'
  | 'needs_setup';

export interface GatewayAdminConnector {
  id: GatewayAdminConnectorId;
  name: string;
  description: string;
  state: GatewayAdminConnectorState;
  authKind: 'api-key' | 'oauth';
  account: string | null;
  detail: string;
  scopes: string[];
  routesConfigured: boolean;
  clientConfigured: boolean;
  clientSecretConfigured: boolean;
  tenantId: string | null;
  loginUrl: string | null;
  adminConsentUrl: string | null;
  setupSecretNames: string[];
}

export interface GatewayAdminConnectorsResponse {
  connectors: GatewayAdminConnector[];
  secretsPath: string;
}

export interface GatewayAdminConnectorOAuthStartResult {
  provider: GatewayAdminOAuthConnectorId;
  authorizationUrl: string;
  state: string;
  expiresAt: number;
}

interface ConnectorOAuthStartInput {
  provider?: unknown;
  account?: unknown;
  tenantId?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  scopes?: unknown;
}

interface PendingConnectorOAuthFlow {
  provider: GatewayAdminLocalOAuthConnectorId;
  account: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  redirectUri: string;
  codeVerifier: string | null;
  codeChallenge: string | null;
  createdAt: number;
}

const pendingConnectorOAuthFlows = new Map<string, PendingConnectorOAuthFlow>();

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readSecretOrEnv(name: string): string {
  return (
    String(process.env[name] || '').trim() ||
    readStoredRuntimeSecret(name) ||
    ''
  );
}

function resolveHybridAIBaseUrl(): string {
  return (HYBRIDAI_BASE_URL || 'https://hybridai.one').replace(/\/+$/g, '');
}

function resolveHybridAILoginUrl(): string {
  return `${resolveHybridAIBaseUrl()}${HYBRIDAI_LOGIN_PATH}`;
}

function resolveHybridAIConnectorUrl(connectorId: string): string {
  const url = new URL(HYBRIDAI_CONNECTORS_PATH, resolveHybridAIBaseUrl());
  url.searchParams.set('connect', connectorId);
  return url.toString();
}

function makeState(): string {
  return randomBytes(32).toString('base64url');
}

function pruneExpiredConnectorOAuthFlows(): void {
  const now = Date.now();
  for (const [state, flow] of pendingConnectorOAuthFlows) {
    if (now - flow.createdAt > PENDING_CONNECTOR_OAUTH_TTL_MS) {
      pendingConnectorOAuthFlows.delete(state);
    }
  }
}

function parseConnectorId(value: unknown): GatewayAdminConnectorId {
  const normalized = trimString(value).toLowerCase();
  if (
    normalized === 'hybridai' ||
    normalized === 'github' ||
    normalized === 'google' ||
    normalized === 'microsoft365'
  ) {
    return normalized;
  }
  if (normalized === 'm365' || normalized === 'microsoft-365') {
    return 'microsoft365';
  }
  throw new GatewayRequestError(
    400,
    'Connector must be `hybridai`, `github`, `google`, or `microsoft365`.',
  );
}

function resolveOAuthRedirectUri(requestBaseUrl?: string): string {
  const baseUrl = String(requestBaseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
  if (!baseUrl) {
    throw new GatewayRequestError(
      400,
      'Cannot determine the gateway base URL for the OAuth redirect.',
    );
  }
  return `${baseUrl}/api/connectors/oauth/callback`;
}

function resolveConnectorReturnUrl(requestBaseUrl?: string): string {
  const baseUrl = String(requestBaseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
  if (!baseUrl) {
    throw new GatewayRequestError(
      400,
      'Cannot determine the gateway base URL for the connector return.',
    );
  }
  return `${baseUrl}/admin/connectors`;
}

function hasGoogleOAuthRoute(): boolean {
  return getRuntimeConfig().tools.httpRequest.authRules.some((rule) =>
    isGoogleOAuthSecretRef(rule.secret),
  );
}

function hasMicrosoftOAuthRoute(): boolean {
  return getRuntimeConfig().tools.httpRequest.authRules.some((rule) =>
    isMicrosoftOAuthSecretRef(rule.secret),
  );
}

function upsertHttpAuthRule(rule: RuntimeHttpRequestAuthRule): void {
  updateRuntimeConfig((draft) => {
    draft.tools.httpRequest.authRules =
      draft.tools.httpRequest.authRules.filter(
        (entry) =>
          !(
            entry.urlPrefix === rule.urlPrefix &&
            entry.header.toLowerCase() === rule.header.toLowerCase()
          ),
      );
    draft.tools.httpRequest.authRules.push(rule);
  });
}

function ensureGoogleWorkspaceRoutes(): void {
  for (const rawPrefix of [
    'https://www.googleapis.com/',
    'https://gmail.googleapis.com/',
    'https://people.googleapis.com/',
  ]) {
    upsertHttpAuthRule({
      urlPrefix: normalizeHttpRequestAuthRuleUrlPrefix(rawPrefix),
      header: 'Authorization',
      prefix: 'Bearer',
      secret: makeGoogleOAuthSecretRef(),
    });
  }
}

function ensureMicrosoftGraphRoute(): void {
  upsertHttpAuthRule({
    urlPrefix: normalizeHttpRequestAuthRuleUrlPrefix(
      'https://graph.microsoft.com/',
    ),
    header: 'Authorization',
    prefix: 'Bearer',
    secret: makeMicrosoftOAuthSecretRef(),
  });
}

function microsoftAdminConsentUrl(
  clientId: string,
  tenantId: string | null,
): string | null {
  if (!clientId) return null;
  const tenant = tenantId || 'organizations';
  const query = new URLSearchParams({ client_id: clientId });
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/adminconsent?${query.toString()}`;
}

function buildHybridAIConnector(): GatewayAdminConnector {
  const status = getHybridAIAuthStatus();
  return {
    id: 'hybridai',
    name: 'HybridAI',
    description:
      'Use HybridAI models, bots, and managed workspace features in HybridClaw.',
    state: status.authenticated ? 'connected' : 'not_connected',
    authKind: 'api-key',
    account: null,
    detail: status.authenticated
      ? `${status.maskedApiKey || 'API key'} via ${status.source || 'runtime'}`
      : 'Paste a HybridAI API key after signing in.',
    scopes: [],
    routesConfigured: true,
    clientConfigured: true,
    clientSecretConfigured: true,
    tenantId: null,
    loginUrl: resolveHybridAILoginUrl(),
    adminConsentUrl: null,
    setupSecretNames: ['HYBRIDAI_API_KEY'],
  };
}

function buildGoogleConnector(): GatewayAdminConnector {
  const status = getGoogleAuthStatus();
  const clientConfigured = Boolean(
    readSecretOrEnv(GOOGLE_OAUTH_CLIENT_ID_SECRET) &&
      readSecretOrEnv(GOOGLE_OAUTH_CLIENT_SECRET_SECRET),
  );
  return {
    id: 'google',
    name: 'Google Workspace',
    description:
      'Bring Gmail, Calendar, Drive, Docs, Sheets, and contacts into your workflows.',
    state: status.authenticated
      ? 'connected'
      : clientConfigured
        ? 'not_connected'
        : 'needs_setup',
    authKind: 'oauth',
    account: status.account || null,
    detail: status.authenticated
      ? 'OAuth refresh token configured.'
      : clientConfigured
        ? 'OAuth client configured. Connect to authorize Google Workspace.'
        : 'OAuth client id and client secret are required before browser authorization.',
    scopes: status.scopes,
    routesConfigured: hasGoogleOAuthRoute(),
    clientConfigured,
    clientSecretConfigured: Boolean(
      readSecretOrEnv(GOOGLE_OAUTH_CLIENT_SECRET_SECRET),
    ),
    tenantId: null,
    loginUrl: null,
    adminConsentUrl: null,
    setupSecretNames: [
      GOOGLE_ACCOUNT_SECRET,
      GOOGLE_OAUTH_CLIENT_ID_SECRET,
      GOOGLE_OAUTH_CLIENT_SECRET_SECRET,
      GOOGLE_OAUTH_SCOPES_SECRET,
    ],
  };
}

function buildGitHubConnector(): GatewayAdminConnector {
  return {
    id: 'github',
    name: 'GitHub',
    description:
      'Work with repositories, pull requests, issues, and code from GitHub.',
    state: 'not_connected',
    authKind: 'oauth',
    account: null,
    detail: 'Managed by HybridAI connectors.',
    scopes: [],
    routesConfigured: true,
    clientConfigured: true,
    clientSecretConfigured: true,
    tenantId: null,
    loginUrl: resolveHybridAIConnectorUrl('github'),
    adminConsentUrl: null,
    setupSecretNames: [],
  };
}

function buildMicrosoft365Connector(): GatewayAdminConnector {
  const status = getMicrosoft365AuthStatus();
  const clientId = readSecretOrEnv(MICROSOFT_365_OAUTH_CLIENT_ID_SECRET);
  const clientSecret = readSecretOrEnv(
    MICROSOFT_365_OAUTH_CLIENT_SECRET_SECRET,
  );
  const tenantId = status.tenantId || 'organizations';
  return {
    id: 'microsoft365',
    name: 'Microsoft 365',
    description:
      'Connect work mail, calendars, files, SharePoint, OneDrive, and Teams.',
    state: status.authenticated
      ? 'connected'
      : clientId
        ? 'not_connected'
        : 'needs_setup',
    authKind: 'oauth',
    account: status.account || null,
    detail: status.authenticated
      ? 'OAuth refresh token configured.'
      : clientId
        ? 'OAuth client configured. Connect to authorize Microsoft Graph.'
        : 'A Microsoft Entra app client id is required until HybridClaw ships its hosted app id.',
    scopes: status.scopes,
    routesConfigured: hasMicrosoftOAuthRoute(),
    clientConfigured: Boolean(clientId),
    clientSecretConfigured: Boolean(clientSecret),
    tenantId,
    loginUrl: null,
    adminConsentUrl: microsoftAdminConsentUrl(clientId, tenantId),
    setupSecretNames: [
      MICROSOFT_365_ACCOUNT_SECRET,
      MICROSOFT_365_TENANT_ID_SECRET,
      MICROSOFT_365_OAUTH_CLIENT_ID_SECRET,
      MICROSOFT_365_OAUTH_CLIENT_SECRET_SECRET,
      MICROSOFT_365_OAUTH_SCOPES_SECRET,
    ],
  };
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function startHybridAIPlatformConnectorOAuth(input: {
  provider: Extract<GatewayAdminConnectorId, 'github'>;
  requestBaseUrl?: string;
}): Promise<GatewayAdminConnectorOAuthStartResult> {
  let apiKey: string;
  try {
    apiKey = getHybridAIApiKey();
  } catch (error) {
    if (error instanceof MissingRequiredEnvVarError) {
      throw new GatewayRequestError(
        400,
        'Connect HybridAI first, then connect GitHub.',
      );
    }
    throw error;
  }

  const response = await fetch(
    `${resolveHybridAIBaseUrl()}/api/v1/connectors/oauth/authorize/${encodeURIComponent(input.provider)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        return_to: resolveConnectorReturnUrl(input.requestBaseUrl),
      }),
    },
  );
  const payload = await readJsonObject(response);
  if (!response.ok) {
    const message =
      trimString(payload.message) ||
      trimString(payload.error) ||
      `HybridAI returned ${response.status}`;
    throw new GatewayRequestError(
      response.status === 401 ? 401 : 502,
      `Could not start ${input.provider} connector authorization: ${message}`,
    );
  }

  const authorizationUrl = trimString(payload.authorization_url);
  if (!authorizationUrl) {
    throw new GatewayRequestError(
      502,
      `HybridAI did not return a ${input.provider} authorization URL.`,
    );
  }

  return {
    provider: input.provider,
    authorizationUrl,
    state: '',
    expiresAt: Date.now() + PENDING_CONNECTOR_OAUTH_TTL_MS,
  };
}

export function getGatewayAdminConnectors(): GatewayAdminConnectorsResponse {
  return {
    connectors: [
      buildHybridAIConnector(),
      buildGitHubConnector(),
      buildGoogleConnector(),
      buildMicrosoft365Connector(),
    ],
    secretsPath: runtimeSecretsPath(),
  };
}

export function saveGatewayAdminHybridAIConnectorApiKey(input: {
  apiKey?: unknown;
}): GatewayAdminConnectorsResponse {
  const apiKey = trimString(input.apiKey);
  if (!apiKey) {
    throw new GatewayRequestError(400, 'HybridAI API key is required.');
  }
  saveNamedRuntimeSecrets({ HYBRIDAI_API_KEY: apiKey });
  refreshRuntimeSecretsFromEnv();
  return getGatewayAdminConnectors();
}

function resolveGoogleOAuthFlow(input: {
  body: ConnectorOAuthStartInput;
  redirectUri: string;
}): PendingConnectorOAuthFlow {
  const current = getGoogleAuthStatus();
  const account = trimString(input.body.account) || current.account;
  const clientId =
    trimString(input.body.clientId) ||
    readSecretOrEnv(GOOGLE_OAUTH_CLIENT_ID_SECRET);
  const clientSecret =
    trimString(input.body.clientSecret) ||
    readSecretOrEnv(GOOGLE_OAUTH_CLIENT_SECRET_SECRET);
  const scopes = parseGoogleScopes(
    trimString(input.body.scopes) ||
      readSecretOrEnv(GOOGLE_OAUTH_SCOPES_SECRET) ||
      DEFAULT_GOOGLE_OAUTH_SCOPES.join(' '),
  );

  if (!account) {
    throw new GatewayRequestError(400, 'Google account email is required.');
  }
  if (!clientId || !clientSecret) {
    throw new GatewayRequestError(
      400,
      'Google OAuth client id and client secret are required.',
    );
  }

  return {
    provider: 'google',
    account,
    tenantId: '',
    clientId,
    clientSecret,
    scopes,
    redirectUri: input.redirectUri,
    codeVerifier: null,
    codeChallenge: null,
    createdAt: Date.now(),
  };
}

function resolveMicrosoft365OAuthFlow(input: {
  body: ConnectorOAuthStartInput;
  redirectUri: string;
}): PendingConnectorOAuthFlow {
  const current = getMicrosoft365AuthStatus();
  const account = trimString(input.body.account) || current.account;
  const tenantId =
    trimString(input.body.tenantId) ||
    readSecretOrEnv(MICROSOFT_365_TENANT_ID_SECRET) ||
    current.tenantId ||
    'organizations';
  const clientId =
    trimString(input.body.clientId) ||
    readSecretOrEnv(MICROSOFT_365_OAUTH_CLIENT_ID_SECRET);
  const clientSecret =
    trimString(input.body.clientSecret) ||
    readSecretOrEnv(MICROSOFT_365_OAUTH_CLIENT_SECRET_SECRET);
  const scopes = parseMicrosoft365Scopes(
    trimString(input.body.scopes) ||
      readSecretOrEnv(MICROSOFT_365_OAUTH_SCOPES_SECRET) ||
      DEFAULT_MICROSOFT_365_OAUTH_SCOPES.join(' '),
  );
  const pkce = createMicrosoft365PkcePair();

  if (!clientId) {
    throw new GatewayRequestError(
      400,
      'Microsoft 365 OAuth client id is required.',
    );
  }

  return {
    provider: 'microsoft365',
    account,
    tenantId,
    clientId,
    clientSecret,
    scopes,
    redirectUri: input.redirectUri,
    codeVerifier: pkce.verifier,
    codeChallenge: pkce.challenge,
    createdAt: Date.now(),
  };
}

export async function startGatewayAdminConnectorOAuth(input: {
  body: ConnectorOAuthStartInput;
  requestBaseUrl?: string;
}): Promise<GatewayAdminConnectorOAuthStartResult> {
  pruneExpiredConnectorOAuthFlows();
  const provider = parseConnectorId(input.body.provider);
  if (provider === 'hybridai') {
    throw new GatewayRequestError(
      400,
      'HybridAI uses an API key flow, not OAuth.',
    );
  }
  if (provider === 'github') {
    return startHybridAIPlatformConnectorOAuth({
      provider,
      requestBaseUrl: input.requestBaseUrl,
    });
  }

  const redirectUri = resolveOAuthRedirectUri(input.requestBaseUrl);
  const state = makeState();
  const flow =
    provider === 'google'
      ? resolveGoogleOAuthFlow({ body: input.body, redirectUri })
      : resolveMicrosoft365OAuthFlow({ body: input.body, redirectUri });

  pendingConnectorOAuthFlows.set(state, flow);
  if (provider === 'microsoft365' && !flow.codeChallenge) {
    pendingConnectorOAuthFlows.delete(state);
    throw new GatewayRequestError(
      400,
      'Microsoft 365 OAuth flow is missing PKCE challenge state.',
    );
  }

  return {
    provider,
    state,
    expiresAt: flow.createdAt + PENDING_CONNECTOR_OAUTH_TTL_MS,
    authorizationUrl:
      provider === 'google'
        ? buildGoogleAuthorizeUrl({
            clientId: flow.clientId,
            redirectUri,
            state,
            scopes: flow.scopes,
          })
        : buildMicrosoft365AuthorizeUrl({
            tenantId: flow.tenantId,
            clientId: flow.clientId,
            redirectUri,
            state,
            scopes: flow.scopes,
            codeChallenge: flow.codeChallenge || '',
          }),
  };
}

export async function completeGatewayAdminConnectorOAuthCallback(input: {
  state: string;
  code: string;
}): Promise<{ provider: GatewayAdminConnectorId; name: string }> {
  pruneExpiredConnectorOAuthFlows();
  const flow = pendingConnectorOAuthFlows.get(input.state);
  if (!flow) {
    throw new GatewayRequestError(
      400,
      'Unknown or expired connector OAuth state. Restart the login flow.',
    );
  }
  pendingConnectorOAuthFlows.delete(input.state);

  if (flow.provider === 'google') {
    const exchanged = await exchangeGoogleAuthorizationCode({
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      code: input.code,
      redirectUri: flow.redirectUri,
    });
    await loginGoogle({
      account: flow.account,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      refreshToken: exchanged.refreshToken,
      scopes: flow.scopes,
    });
    ensureGoogleWorkspaceRoutes();
    return { provider: 'google', name: 'Google Workspace' };
  }

  if (!flow.codeVerifier) {
    throw new GatewayRequestError(
      400,
      'Microsoft 365 OAuth flow is missing PKCE verifier state.',
    );
  }
  const exchanged = await exchangeMicrosoft365AuthorizationCode({
    tenantId: flow.tenantId,
    clientId: flow.clientId,
    clientSecret: flow.clientSecret,
    code: input.code,
    redirectUri: flow.redirectUri,
    codeVerifier: flow.codeVerifier,
    scopes: flow.scopes,
  });
  await loginMicrosoft365({
    account: flow.account,
    tenantId: flow.tenantId,
    clientId: flow.clientId,
    clientSecret: flow.clientSecret,
    refreshToken: exchanged.refreshToken,
    scopes: flow.scopes,
  });
  ensureMicrosoftGraphRoute();
  return { provider: 'microsoft365', name: 'Microsoft 365' };
}

export function logoutGatewayAdminConnector(input: {
  provider?: unknown;
}): GatewayAdminConnectorsResponse {
  const provider = parseConnectorId(input.provider);
  if (provider === 'hybridai') {
    clearHybridAICredentials();
  } else if (provider === 'github') {
    throw new GatewayRequestError(
      400,
      'GitHub is managed through HybridAI connectors.',
    );
  } else if (provider === 'google') {
    clearGoogleAuth();
  } else {
    clearMicrosoft365Auth();
  }
  return getGatewayAdminConnectors();
}
