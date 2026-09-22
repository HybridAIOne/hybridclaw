/**
 * Sign in to the HybridAI platform with OAuth 2.1 instead of a pasted
 * platform API key.
 *
 * The platform is an OAuth 2.1 authorization server (RFC 8414 discovery,
 * RFC 7591 open registration, authorization code + S256 PKCE, refresh token
 * rotation). HybridClaw registers itself as a public client with a loopback
 * redirect, sends the user to the consent screen, and exchanges the returned
 * code for an `api`-scoped access token.
 *
 * Storage keeps every existing consumer untouched: the current access token
 * is stored as `HYBRIDAI_API_KEY` in the encrypted runtime secret store (the
 * platform accepts `hao_` tokens wherever it accepts `hai-` keys), and the
 * refresh token plus client metadata live next to it under
 * `HYBRIDAI_OAUTH`. {@link ensureFreshHybridAIAccessToken} rotates the
 * access token before it expires; the gateway runs it on a timer.
 */
import http from 'node:http';
import type readline from 'node:readline/promises';

import {
  HYBRIDAI_API_KEY,
  refreshRuntimeSecretsFromEnv,
} from '../config/config.js';
import { logger } from '../logger.js';
import {
  readStoredRuntimeSecret,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { tryOpenUrlInBrowser } from '../utils/open-url.js';
import { isRecord } from '../utils/type-guards.js';
import {
  type AuthorizationServerMetadata,
  DEVICE_CODE_GRANT_TYPE,
  discoverAuthorizationServerMetadata,
  generateOAuthState,
  generatePkcePair,
  OAuthTokenRequestError,
  type OAuthTokenSet,
  pollDeviceToken,
  registerPublicClient,
  requestDeviceAuthorization,
  requestToken,
  revokeToken,
} from './oauth2-client.js';

export const HYBRIDAI_OAUTH_SECRET = 'HYBRIDAI_OAUTH';
export const HYBRIDAI_OAUTH_SCOPE = 'profile api mcp';
const HYBRIDAI_ACCESS_TOKEN_PREFIX = 'hao_';
const CLIENT_NAME = 'HybridClaw';
const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/oauth/callback';
/** Registration demands a redirect URI; the device flow never uses it. */
const DEVICE_FLOW_PLACEHOLDER_REDIRECT_URI = `http://${LOOPBACK_HOST}${CALLBACK_PATH}`;
const DEFAULT_CALLBACK_TIMEOUT_MS = 10 * 60_000;
const USERINFO_TIMEOUT_MS = 10_000;
/** Refresh once less than this much of the access token lifetime is left. */
const REFRESH_MIN_TTL_MS = 15 * 60_000;

export interface HybridAIOAuthAccount {
  sub: string;
  email?: string;
  name?: string;
}

export interface HybridAIOAuthRecord {
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  scope: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  account?: HybridAIOAuthAccount;
  updatedAt: string;
}

export interface HybridAIAuthorization {
  authorizationUrl: string;
  redirectUri: string;
  /** Resolves with the authorization code once the browser redirects back. */
  waitForCode: Promise<string>;
  /**
   * Headless fallback: feed the redirect URL (or the bare code) the user
   * pasted from the browser's address bar. Settles `waitForCode`.
   */
  submitRedirect(input: string): void;
  /**
   * Exchange the authorization code, store the access token as
   * `HYBRIDAI_API_KEY` and the refresh material as `HYBRIDAI_OAUTH`.
   */
  complete(code: string): Promise<HybridAISignInResult>;
  close(): void;
}

export interface HybridAISignInResult {
  accessToken: string;
  account?: HybridAIOAuthAccount;
}

export function isHybridAIAccessToken(value: string): boolean {
  return value.trim().startsWith(HYBRIDAI_ACCESS_TOKEN_PREFIX);
}

export function readHybridAIOAuthRecord(): HybridAIOAuthRecord | null {
  const raw = readStoredRuntimeSecret(HYBRIDAI_OAUTH_SECRET);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const record = parsed as unknown as HybridAIOAuthRecord;
    if (!record.issuer || !record.tokenEndpoint || !record.clientId) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

/**
 * Store the access token and the OAuth session in one write, so no reader
 * ever sees a token without its session or the other way around.
 */
function saveHybridAISession(
  accessToken: string | null,
  record: HybridAIOAuthRecord | null,
): void {
  saveNamedRuntimeSecrets({
    HYBRIDAI_API_KEY: accessToken,
    [HYBRIDAI_OAUTH_SECRET]: record ? JSON.stringify(record) : null,
  });
  refreshRuntimeSecretsFromEnv();
}

export function clearHybridAIOAuthRecord(): void {
  saveNamedRuntimeSecrets({ [HYBRIDAI_OAUTH_SECRET]: null });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function callbackPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;line-height:1.5}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
}

/** The platform offers no OAuth sign-in (no metadata or no registration). */
export class HybridAIOAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HybridAIOAuthUnavailableError';
  }
}

async function discoverHybridAIOAuth(baseUrl: string): Promise<{
  issuer: string;
  metadata: AuthorizationServerMetadata & { registrationEndpoint: string };
}> {
  const issuer = baseUrl.trim().replace(/\/+$/, '');
  const metadata = await discoverAuthorizationServerMetadata(issuer);
  if (!metadata) {
    throw new HybridAIOAuthUnavailableError(
      `${issuer} does not publish OAuth authorization server metadata. Sign in with an API key instead (\`hybridclaw auth login hybridai --api-key\`).`,
    );
  }
  const registrationEndpoint = metadata.registrationEndpoint;
  if (!registrationEndpoint) {
    throw new HybridAIOAuthUnavailableError(
      `${issuer} does not support dynamic client registration. Sign in with an API key instead (\`hybridclaw auth login hybridai --api-key\`).`,
    );
  }
  return { issuer, metadata: { ...metadata, registrationEndpoint } };
}

/**
 * Discover the platform's authorization server, register a loopback public
 * client and start listening for the redirect. The returned authorization
 * URL must be opened in a browser; `waitForCode` settles when the browser
 * hits the loopback listener or when a pasted redirect is submitted.
 */
export async function startHybridAIAuthorization(input: {
  baseUrl: string;
  timeoutMs?: number;
}): Promise<HybridAIAuthorization> {
  const { issuer, metadata } = await discoverHybridAIOAuth(input.baseUrl);

  const listener = await startLoopbackListener(
    input.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
  );
  try {
    const client = await registerPublicClient({
      registrationEndpoint: metadata.registrationEndpoint,
      redirectUri: listener.redirectUri,
      clientName: CLIENT_NAME,
    });
    const pkce = generatePkcePair();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: listener.redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state: listener.state,
      scope: HYBRIDAI_OAUTH_SCOPE,
    });
    const separator = metadata.authorizationEndpoint.includes('?') ? '&' : '?';
    let completed = false;
    return {
      authorizationUrl: `${metadata.authorizationEndpoint}${separator}${query.toString()}`,
      redirectUri: listener.redirectUri,
      waitForCode: listener.waitForCode,
      submitRedirect: listener.submitRedirect,
      close: listener.close,
      complete: async (code: string) => {
        if (completed) {
          throw new Error('This HybridAI sign-in was already completed.');
        }
        completed = true;
        const tokens = await requestToken(
          metadata.tokenEndpoint,
          new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: listener.redirectUri,
            client_id: client.clientId,
            code_verifier: pkce.verifier,
          }),
        );
        return await storeSignIn({
          issuer,
          metadata,
          clientId: client.clientId,
          tokens,
        });
      },
    };
  } catch (err) {
    listener.close();
    throw err;
  }
}

export interface HybridAIDeviceAuthorization {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  /** Polls the platform until the user approves or denies on `/device`. */
  waitForSignIn(): Promise<HybridAISignInResult>;
  cancel(): void;
}

/**
 * RFC 8628 device flow for machines the browser cannot reach (SSH sessions,
 * containers): the user types a short code into the platform's `/device`
 * page. Returns null when the platform does not offer the device grant, so
 * callers can fall back to the loopback flow with a pasted redirect.
 */
export async function startHybridAIDeviceAuthorization(input: {
  baseUrl: string;
}): Promise<HybridAIDeviceAuthorization | null> {
  const { issuer, metadata } = await discoverHybridAIOAuth(input.baseUrl);
  const deviceAuthorizationEndpoint = metadata.deviceAuthorizationEndpoint;
  if (!deviceAuthorizationEndpoint) return null;

  const client = await registerPublicClient({
    registrationEndpoint: metadata.registrationEndpoint,
    redirectUri: DEVICE_FLOW_PLACEHOLDER_REDIRECT_URI,
    clientName: CLIENT_NAME,
    grantTypes: ['refresh_token', DEVICE_CODE_GRANT_TYPE],
  });
  const device = await requestDeviceAuthorization({
    deviceAuthorizationEndpoint,
    clientId: client.clientId,
    scope: HYBRIDAI_OAUTH_SCOPE,
  });
  const abort = new AbortController();
  let started = false;
  return {
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
    expiresAt: device.expiresAt,
    waitForSignIn: async () => {
      if (started) {
        throw new Error('This HybridAI device sign-in was already started.');
      }
      started = true;
      const tokens = await pollDeviceToken({
        tokenEndpoint: metadata.tokenEndpoint,
        clientId: client.clientId,
        device,
        signal: abort.signal,
      });
      return await storeSignIn({
        issuer,
        metadata,
        clientId: client.clientId,
        tokens,
      });
    },
    cancel: () => abort.abort(),
  };
}

interface LoopbackListener {
  redirectUri: string;
  state: string;
  waitForCode: Promise<string>;
  submitRedirect(input: string): void;
  close(): void;
}

function parseRedirectInput(
  raw: string,
  expectedState: string,
): { code?: string; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'empty input' };
  let params: URLSearchParams;
  try {
    params = new URL(trimmed).searchParams;
  } catch {
    // Bare authorization code pasted without the redirect URL.
    return /^[A-Za-z0-9._~-]+$/.test(trimmed)
      ? { code: trimmed }
      : { error: 'not a redirect URL or authorization code' };
  }
  if ((params.get('state') || '') !== expectedState) {
    return { error: 'state mismatch' };
  }
  const error = params.get('error');
  if (error) return { error: params.get('error_description') || error };
  const code = params.get('code') || '';
  return code ? { code } : { error: 'missing authorization code' };
}

function startLoopbackListener(timeoutMs: number): Promise<LoopbackListener> {
  const state = generateOAuthState();
  return new Promise((resolveStart, rejectStart) => {
    let settled = false;
    let resolveCode: (code: string) => void = () => {};
    let rejectCode: (error: unknown) => void = () => {};
    const waitForCode = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    function settle(outcome: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      outcome();
    }

    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url || '/', `http://${LOOPBACK_HOST}`);
      if (requestUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const parsed = parseRedirectInput(requestUrl.toString(), state);
      if (parsed.code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          callbackPage(
            'Signed in to HybridClaw',
            'You can close this tab and return to the terminal.',
          ),
        );
        settle(() => resolveCode(parsed.code as string));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        callbackPage(
          'HybridAI sign-in failed',
          `${parsed.error}. Return to HybridClaw and retry.`,
        ),
      );
      // A foreign state is noise (another tab, a stale flow); keep waiting.
      if (parsed.error !== 'state mismatch') {
        settle(() =>
          rejectCode(new Error(`HybridAI sign-in failed: ${parsed.error}`)),
        );
      }
    });

    server.once('error', (error) => {
      rejectStart(error);
      settle(() => rejectCode(error));
    });

    const timer = setTimeout(() => {
      settle(() =>
        rejectCode(new Error('Timed out waiting for the HybridAI sign-in.')),
      );
    }, timeoutMs);
    timer.unref();

    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveStart({
        redirectUri: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`,
        state,
        waitForCode,
        submitRedirect: (input: string) => {
          const parsed = parseRedirectInput(input, state);
          if (parsed.code) {
            settle(() => resolveCode(parsed.code as string));
          } else {
            settle(() =>
              rejectCode(new Error(`HybridAI sign-in failed: ${parsed.error}`)),
            );
          }
        },
        close: () =>
          settle(() => rejectCode(new Error('HybridAI sign-in canceled.'))),
      });
    });
  });
}

/**
 * Wait for the browser redirect while also accepting a pasted redirect URL
 * on the terminal, for machines the browser cannot reach (SSH, containers).
 * Whichever arrives first wins; the other side is canceled.
 */
async function waitForHybridAIAuthorizationCode(
  authorization: HybridAIAuthorization,
  prompt: { rl: readline.Interface; text: string },
): Promise<string> {
  const abort = new AbortController();
  const pasted = prompt.rl
    .question(prompt.text, { signal: abort.signal })
    .then((answer) => {
      if (answer.trim()) authorization.submitRedirect(answer);
    })
    .catch(() => {
      // Aborted because the loopback redirect arrived first.
    });
  try {
    return await authorization.waitForCode;
  } finally {
    abort.abort();
    await pasted;
    process.stdout.write('\n');
  }
}

/** Terminal output for {@link signInToHybridAI}; the CLI and onboarding style it differently. */
export interface HybridAISignInUI {
  rl: readline.Interface;
  info(message: string): void;
  warn(message: string): void;
  link(url: string): void;
  confirm(question: string): Promise<boolean>;
  /** Styles the prompt that accepts a pasted redirect URL. */
  pastePrompt(text: string): string;
}

/**
 * Interactive platform sign-in. `browser` runs the authorization code + PKCE
 * flow with a loopback redirect and offers to open the consent page.
 * `device-code` (headless shells) prefers the RFC 8628 device flow; platforms
 * without it get the loopback flow with a pasted redirect instead.
 *
 * Throws {@link HybridAIOAuthUnavailableError} when the platform offers no
 * OAuth sign-in at all.
 */
export async function signInToHybridAI(input: {
  baseUrl: string;
  method: 'browser' | 'device-code';
  ui: HybridAISignInUI;
}): Promise<HybridAISignInResult> {
  const { baseUrl, method, ui } = input;
  if (method === 'device-code') {
    const device = await startHybridAIDeviceAuthorization({ baseUrl });
    if (device) {
      ui.info('On any device with a browser, open:');
      ui.link(device.verificationUri);
      ui.info(`and enter the code:  ${device.userCode}`);
      if (device.verificationUriComplete) {
        ui.info(`(or open ${device.verificationUriComplete} directly)`);
      }
      const minutes = Math.max(
        1,
        Math.round((device.expiresAt - Date.now()) / 60_000),
      );
      ui.info(`Waiting for approval (code valid for ${minutes} min) ...`);
      return await device.waitForSignIn();
    }
  }

  const authorization = await startHybridAIAuthorization({ baseUrl });
  try {
    ui.info(
      'Sign in (or create an account) in your browser and approve HybridClaw.',
    );
    if (
      method === 'browser' &&
      (await ui.confirm('Open the HybridAI sign-in page in your browser now?'))
    ) {
      if (!(await tryOpenUrlInBrowser(authorization.authorizationUrl))) {
        ui.warn('Could not auto-open browser. Open the link manually.');
      }
    }
    ui.link(authorization.authorizationUrl);
    ui.info(
      `Waiting for the browser to return to ${authorization.redirectUri} ...`,
    );
    const code = await waitForHybridAIAuthorizationCode(authorization, {
      rl: ui.rl,
      text: ui.pastePrompt(
        'If the browser cannot reach this machine, paste the URL it was redirected to here: ',
      ),
    });
    return await authorization.complete(code);
  } finally {
    authorization.close();
  }
}

async function fetchUserInfo(
  userinfoEndpoint: string | undefined,
  accessToken: string,
): Promise<HybridAIOAuthAccount | undefined> {
  if (!userinfoEndpoint) return undefined;
  try {
    const response = await fetch(userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || typeof payload.sub !== 'string') return undefined;
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Persist a fresh token set as the HybridAI credential + OAuth session. */
async function storeSignIn(session: {
  issuer: string;
  metadata: AuthorizationServerMetadata;
  clientId: string;
  tokens: OAuthTokenSet;
}): Promise<HybridAISignInResult> {
  const { metadata, tokens } = session;
  const account = await fetchUserInfo(
    metadata.userinfoEndpoint,
    tokens.accessToken,
  );
  saveHybridAISession(tokens.accessToken, {
    issuer: session.issuer,
    tokenEndpoint: metadata.tokenEndpoint,
    revocationEndpoint: metadata.revocationEndpoint,
    clientId: session.clientId,
    scope: tokens.scope || HYBRIDAI_OAUTH_SCOPE,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: tokens.expiresAt,
    account,
    updatedAt: new Date().toISOString(),
  });
  return { accessToken: tokens.accessToken, account };
}

export type HybridAITokenRefreshOutcome =
  | 'not-oauth'
  | 'fresh'
  | 'refreshed'
  | 'signed-out'
  | 'unavailable';

let refreshInFlight: Promise<HybridAITokenRefreshOutcome> | null = null;

/**
 * Rotate the stored access token when it is about to expire.
 *
 * - `not-oauth`: no OAuth session (env key, pasted `hai-` key, or nothing).
 * - `fresh`: the stored token still has more than 15 minutes left.
 * - `refreshed`: a new access token was stored (by this or another process).
 * - `signed-out`: the platform rejected the refresh token (revoked, expired,
 *   reused); the stale access token was removed so callers fail with a clear
 *   "not configured" error instead of opaque 401s. Sign in again.
 * - `unavailable`: transient failure (network, 5xx); nothing changed.
 *
 * The CLI and the gateway share one secret store, so another process may
 * rotate the session at any time; the store, not this process, is the source
 * of truth.
 */
export function ensureFreshHybridAIAccessToken(): Promise<HybridAITokenRefreshOutcome> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshHybridAIAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshHybridAIAccessToken(): Promise<HybridAITokenRefreshOutcome> {
  const record = readHybridAIOAuthRecord();
  if (!record) return 'not-oauth';

  const stored = readStoredRuntimeSecret('HYBRIDAI_API_KEY') || '';
  if (stored && !isHybridAIAccessToken(stored)) {
    // Someone stored a platform API key over the OAuth session (console,
    // `secret set`); the key wins and the session is stale.
    clearHybridAIOAuthRecord();
    logger.info(
      'HybridAI OAuth session dropped: a platform API key replaced the access token',
    );
    return 'not-oauth';
  }
  if (
    stored &&
    typeof record.accessExpiresAt === 'number' &&
    record.accessExpiresAt - Date.now() > REFRESH_MIN_TTL_MS
  ) {
    if (stored !== HYBRIDAI_API_KEY) refreshRuntimeSecretsFromEnv();
    return 'fresh';
  }
  if (!record.refreshToken) {
    saveHybridAISession(null, record);
    return 'signed-out';
  }

  try {
    const tokens = await requestToken(
      record.tokenEndpoint,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: record.refreshToken,
        client_id: record.clientId,
      }),
    );
    saveHybridAISession(tokens.accessToken, {
      ...record,
      refreshToken: tokens.refreshToken || record.refreshToken,
      accessExpiresAt: tokens.expiresAt,
      scope: tokens.scope || record.scope,
      updatedAt: new Date().toISOString(),
    });
    logger.info(
      { expiresAt: tokens.expiresAt ?? null },
      'HybridAI access token refreshed',
    );
    return 'refreshed';
  } catch (err) {
    if (err instanceof OAuthTokenRequestError && err.code === 'invalid_grant') {
      const current = readHybridAIOAuthRecord();
      if (
        current?.refreshToken &&
        current.refreshToken !== record.refreshToken
      ) {
        // Another process rotated the session while this request was in flight.
        refreshRuntimeSecretsFromEnv();
        return 'refreshed';
      }
      saveHybridAISession(null, {
        ...record,
        refreshToken: undefined,
        accessExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      });
      logger.warn(
        { error: err.message },
        'HybridAI OAuth session ended; run `hybridclaw auth login hybridai` to sign in again',
      );
      return 'signed-out';
    }
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'HybridAI access token refresh failed; will retry',
    );
    return 'unavailable';
  }
}

/** Revoke the refresh token family at the platform (best-effort) and forget the session. */
export async function revokeHybridAIOAuthSession(): Promise<boolean> {
  const record = readHybridAIOAuthRecord();
  if (!record) return false;
  let revoked = false;
  if (record.revocationEndpoint && record.refreshToken) {
    revoked = await revokeToken({
      revocationEndpoint: record.revocationEndpoint,
      token: record.refreshToken,
      tokenTypeHint: 'refresh_token',
      clientId: record.clientId,
    });
  }
  clearHybridAIOAuthRecord();
  return revoked;
}

const TOKEN_MAINTENANCE_INTERVAL_MS = 60_000;

/**
 * Keep the access token fresh for a long-running process. Runs one refresh
 * immediately (errors are logged, never thrown) and then every minute.
 */
export function startHybridAIAccessTokenMaintenance(): () => void {
  const tick = () => {
    void ensureFreshHybridAIAccessToken().catch((err: unknown) => {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'HybridAI access token maintenance failed',
      );
    });
  };
  tick();
  const timer = setInterval(tick, TOKEN_MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
