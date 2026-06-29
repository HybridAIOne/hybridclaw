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
  mintGoogleAccessToken,
  parseGoogleScopes,
} from '../auth/google-auth.js';
import {
  clearHybridAICredentials,
  getHybridAIApiKey,
  getHybridAIAuthStatus,
} from '../auth/hybridai-auth.js';
import {
  HYBRIDAI_BASE_URL,
  MissingRequiredEnvVarError,
  refreshRuntimeSecretsFromEnv,
} from '../config/config.js';
import {
  getRuntimeConfig,
  isGoogleOAuthSecretRef,
  makeGoogleOAuthSecretRef,
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
type GatewayAdminPlatformConnectorId = Extract<
  GatewayAdminConnectorId,
  'github' | 'microsoft365'
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

export interface GatewayAdminConnectorTestResult {
  provider: GatewayAdminConnectorId;
  name: string;
  ok: boolean;
  message: string;
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
  clientId?: unknown;
  clientSecret?: unknown;
  scopes?: unknown;
}

interface PendingConnectorOAuthFlow {
  account: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  redirectUri: string;
  createdAt: number;
}

interface HybridAIPlatformConnectorStatus {
  connected: boolean;
  account: string | null;
}

const pendingConnectorOAuthFlows = new Map<string, PendingConnectorOAuthFlow>();

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'failed');
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

function resolveHybridAIUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${resolveHybridAIBaseUrl()}${normalizedPath}`;
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

function buildGitHubConnector(
  status?: HybridAIPlatformConnectorStatus,
): GatewayAdminConnector {
  const connected = status?.connected === true;
  return {
    id: 'github',
    name: 'GitHub',
    description:
      'Work with repositories, pull requests, issues, and code from GitHub.',
    state: connected ? 'connected' : 'not_connected',
    authKind: 'oauth',
    account: status?.account || null,
    detail: connected
      ? 'Connected through HybridAI.'
      : 'Managed by HybridAI connectors.',
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

function buildMicrosoft365Connector(
  status?: HybridAIPlatformConnectorStatus,
): GatewayAdminConnector {
  const connected = status?.connected === true;
  return {
    id: 'microsoft365',
    name: 'Microsoft 365',
    description:
      'Connect work mail, calendars, files, SharePoint, OneDrive, and Teams.',
    state: connected ? 'connected' : 'not_connected',
    authKind: 'oauth',
    account: status?.account || null,
    detail: connected
      ? 'Connected through HybridAI.'
      : 'Managed by HybridAI connectors.',
    scopes: [],
    routesConfigured: true,
    clientConfigured: true,
    clientSecretConfigured: true,
    tenantId: null,
    loginUrl: resolveHybridAIConnectorUrl('microsoft365'),
    adminConsentUrl: null,
    setupSecretNames: [],
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

function messageFromHybridAIResponse(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  return (
    trimString(payload.message) ||
    trimString(payload.error) ||
    trimString(payload.text) ||
    fallback
  );
}

function parseHybridAIPlatformConnectorStatuses(
  payload: Record<string, unknown>,
): Map<string, HybridAIPlatformConnectorStatus> {
  const connectors = Array.isArray(payload.connectors)
    ? payload.connectors
    : [];
  const statuses = new Map<string, HybridAIPlatformConnectorStatus>();
  for (const entry of connectors) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = normalizeHybridAIPlatformConnectorId(record.id);
    if (!id) continue;
    statuses.set(id, {
      connected:
        record.connected === true || trimString(record.status) === 'connected',
      account:
        trimString(record.account) ||
        trimString(record.username) ||
        trimString(record.owner) ||
        null,
    });
  }
  return statuses;
}

function normalizeHybridAIPlatformConnectorId(
  value: unknown,
): GatewayAdminPlatformConnectorId | null {
  const id = trimString(value).toLowerCase();
  if (id === 'github') return 'github';
  if (
    id === 'microsoft365' ||
    id === 'microsoft-365' ||
    id === 'm365' ||
    id === 'windows365' ||
    id === 'windows-365'
  ) {
    return 'microsoft365';
  }
  return null;
}

function platformConnectorName(
  provider: GatewayAdminPlatformConnectorId,
): string {
  return provider === 'github' ? 'GitHub' : 'Microsoft 365';
}

async function readHybridAIPlatformConnectorStatuses(): Promise<
  Map<string, HybridAIPlatformConnectorStatus>
> {
  let apiKey: string;
  try {
    apiKey = getHybridAIApiKey();
  } catch (error) {
    if (error instanceof MissingRequiredEnvVarError) return new Map();
    throw error;
  }

  try {
    const response = await fetch(
      resolveHybridAIUrl('/api/v1/connectors/directory'),
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    if (!response.ok) return new Map();
    return parseHybridAIPlatformConnectorStatuses(
      await readJsonObject(response),
    );
  } catch {
    return new Map();
  }
}

function testResult(input: {
  provider: GatewayAdminConnectorId;
  name: string;
  ok: boolean;
  message: string;
}): GatewayAdminConnectorTestResult {
  return input;
}

async function testHybridAIConnector(): Promise<GatewayAdminConnectorTestResult> {
  let apiKey: string;
  try {
    apiKey = getHybridAIApiKey();
  } catch (error) {
    if (error instanceof MissingRequiredEnvVarError) {
      return testResult({
        provider: 'hybridai',
        name: 'HybridAI',
        ok: false,
        message: 'No HybridAI API key is configured for this gateway.',
      });
    }
    throw error;
  }

  try {
    const response = await fetch(
      resolveHybridAIUrl('/api/v1/bot-management/bots'),
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    const payload = await readJsonObject(response);
    if (response.ok) {
      return testResult({
        provider: 'hybridai',
        name: 'HybridAI',
        ok: true,
        message: `HybridAI accepted this key at ${resolveHybridAIBaseUrl()}.`,
      });
    }
    return testResult({
      provider: 'hybridai',
      name: 'HybridAI',
      ok: false,
      message: messageFromHybridAIResponse(
        payload,
        `HybridAI returned HTTP ${response.status}.`,
      ),
    });
  } catch (error) {
    return testResult({
      provider: 'hybridai',
      name: 'HybridAI',
      ok: false,
      message: `Could not reach HybridAI: ${errorMessage(error)}`,
    });
  }
}

async function testHybridAIPlatformConnector(
  provider: GatewayAdminPlatformConnectorId,
): Promise<GatewayAdminConnectorTestResult> {
  const name = platformConnectorName(provider);
  let apiKey: string;
  try {
    apiKey = getHybridAIApiKey();
  } catch (error) {
    if (error instanceof MissingRequiredEnvVarError) {
      return testResult({
        provider,
        name,
        ok: false,
        message: `Connect HybridAI first, then connect ${name}.`,
      });
    }
    throw error;
  }

  try {
    const response = await fetch(
      resolveHybridAIUrl('/api/v1/connectors/directory'),
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    const payload = await readJsonObject(response);
    if (!response.ok) {
      return testResult({
        provider,
        name,
        ok: false,
        message: messageFromHybridAIResponse(
          payload,
          `HybridAI connector directory returned HTTP ${response.status}.`,
        ),
      });
    }

    const connectors = parseHybridAIPlatformConnectorStatuses(payload);
    const connector = connectors.get(provider);

    if (connector?.connected === true) {
      return testResult({
        provider,
        name,
        ok: true,
        message: `${name} is connected for this HybridAI account.`,
      });
    }
    return testResult({
      provider,
      name,
      ok: false,
      message: `${name} is not connected for this HybridAI account.`,
    });
  } catch (error) {
    return testResult({
      provider,
      name,
      ok: false,
      message: `Could not reach HybridAI connectors: ${errorMessage(error)}`,
    });
  }
}

async function testGoogleConnector(): Promise<GatewayAdminConnectorTestResult> {
  try {
    const minted = await mintGoogleAccessToken();
    if (!minted) {
      return testResult({
        provider: 'google',
        name: 'Google Workspace',
        ok: false,
        message: 'Google Workspace is not connected.',
      });
    }
    return testResult({
      provider: 'google',
      name: 'Google Workspace',
      ok: true,
      message: minted.account
        ? `Google Workspace is ready for ${minted.account}.`
        : 'Google Workspace is ready to use.',
    });
  } catch (error) {
    return testResult({
      provider: 'google',
      name: 'Google Workspace',
      ok: false,
      message: errorMessage(error),
    });
  }
}

export async function testGatewayAdminConnector(input: {
  provider?: unknown;
}): Promise<GatewayAdminConnectorTestResult> {
  const provider = parseConnectorId(input.provider);
  if (provider === 'hybridai') return testHybridAIConnector();
  if (provider === 'github' || provider === 'microsoft365') {
    return testHybridAIPlatformConnector(provider);
  }
  return testGoogleConnector();
}

async function startHybridAIPlatformConnectorOAuth(input: {
  provider: GatewayAdminPlatformConnectorId;
  requestBaseUrl?: string;
}): Promise<GatewayAdminConnectorOAuthStartResult> {
  const name = platformConnectorName(input.provider);
  let apiKey: string;
  try {
    apiKey = getHybridAIApiKey();
  } catch (error) {
    if (error instanceof MissingRequiredEnvVarError) {
      throw new GatewayRequestError(
        400,
        `Connect HybridAI first, then connect ${name}.`,
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

export async function getGatewayAdminConnectorsWithPlatformState(): Promise<GatewayAdminConnectorsResponse> {
  const platformStatuses = await readHybridAIPlatformConnectorStatuses();
  return {
    connectors: [
      buildHybridAIConnector(),
      buildGitHubConnector(platformStatuses.get('github')),
      buildGoogleConnector(),
      buildMicrosoft365Connector(platformStatuses.get('microsoft365')),
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
    account,
    clientId,
    clientSecret,
    scopes,
    redirectUri: input.redirectUri,
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
  if (provider === 'github' || provider === 'microsoft365') {
    return startHybridAIPlatformConnectorOAuth({
      provider,
      requestBaseUrl: input.requestBaseUrl,
    });
  }

  const redirectUri = resolveOAuthRedirectUri(input.requestBaseUrl);
  const state = makeState();
  const flow = resolveGoogleOAuthFlow({ body: input.body, redirectUri });

  pendingConnectorOAuthFlows.set(state, flow);

  return {
    provider: 'google',
    state,
    expiresAt: flow.createdAt + PENDING_CONNECTOR_OAUTH_TTL_MS,
    authorizationUrl: buildGoogleAuthorizeUrl({
      clientId: flow.clientId,
      redirectUri,
      state,
      scopes: flow.scopes,
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

export function logoutGatewayAdminConnector(input: {
  provider?: unknown;
}): GatewayAdminConnectorsResponse {
  const provider = parseConnectorId(input.provider);
  if (provider === 'hybridai') {
    clearHybridAICredentials();
  } else if (provider === 'github' || provider === 'microsoft365') {
    throw new GatewayRequestError(
      400,
      `${platformConnectorName(provider)} is managed through HybridAI connectors.`,
    );
  } else if (provider === 'google') {
    clearGoogleAuth();
  }
  return getGatewayAdminConnectors();
}
