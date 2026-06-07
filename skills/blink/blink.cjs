#!/usr/bin/env node
'use strict';

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 15_000;
const GATEWAY_TIMEOUT_BUFFER_MS = 1_000;
const DEFAULT_COMMAND_POLL_INTERVAL_MS = 1_000;
const DEFAULT_THUMBNAIL_WAIT_MS = 45_000;
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const SKILL_NAME = 'blink';
const REST_PROD_HOST = 'rest-prod.immedia-semi.com';
const DEFAULT_REST_BASE = `https://${REST_PROD_HOST}`;
const DEFAULT_USER_AGENT = '27.0ANDROID_28373244';
const OAUTH_BASE_URL = 'https://api.oauth.blink.com';
const OAUTH_AUTHORIZE_URL = `${OAUTH_BASE_URL}/oauth/v2/authorize`;
const OAUTH_SIGNIN_URL = `${OAUTH_BASE_URL}/oauth/v2/signin`;
const OAUTH_2FA_VERIFY_URL = `${OAUTH_BASE_URL}/oauth/v2/2fa/verify`;
const OAUTH_TOKEN_URL = `${OAUTH_BASE_URL}/oauth/token`;
const OAUTH_CLIENT_ID = 'ios';
const OAUTH_REDIRECT_URI =
  'immedia-blink://applinks.blink.com/signin/callback';
const OAUTH_SCOPE = 'client';
const OAUTH_APP_VERSION = '50.1';
const OAUTH_BROWSER_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const OAUTH_TOKEN_USER_AGENT =
  'Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0';
const OAUTH_HANDOVER_DEFAULT_SECONDS = 90;
let userAgent = DEFAULT_USER_AGENT;
const COST_MEASUREMENT = {
  system: 'UsageTotals',
  subLimitKey: 'blink',
};

const SECRET_NAMES = {
  email: 'BLINK_EMAIL',
  password: 'BLINK_PASSWORD',
  authToken: 'BLINK_AUTH_TOKEN',
  refreshToken: 'BLINK_REFRESH_TOKEN',
  tier: 'BLINK_TIER',
  accountId: 'BLINK_ACCOUNT_ID',
  clientId: 'BLINK_CLIENT_ID',
};

const ENV_NAMES = {
  deviceId: 'BLINK_DEVICE_ID',
  clientName: 'BLINK_CLIENT_NAME',
};

const OPERATION_TIERS = {
  'account-login': 'green',
  'account-refresh': 'green',
  'pin-verify': 'amber',
  'devices-list': 'green',
  'networks-list': 'green',
  'network-status-read': 'green',
  'sync-modules-list': 'green',
  'cameras-list': 'green',
  'camera-config-read': 'green',
  'camera-signals-read': 'green',
  'doorbells-list': 'green',
  'motion-events-list': 'green',
  'clips-list': 'green',
  'clip-download': 'green',
  'thumbnail-download': 'green',
  'network-arm': 'amber',
  'network-disarm': 'amber',
  'camera-motion-set': 'amber',
  'camera-thumbnail-refresh': 'amber',
  'clip-watched-mark': 'amber',
  'clip-delete': 'red',
  'camera-live-view-start': 'red',
};

const HTTP_OPERATIONS = new Set([
  'account-login',
  'account-refresh',
  'pin-verify',
  'devices-list',
  'networks-list',
  'network-status-read',
  'sync-modules-list',
  'cameras-list',
  'camera-config-read',
  'camera-signals-read',
  'doorbells-list',
  'motion-events-list',
  'clips-list',
  'clip-download',
  'thumbnail-download',
]);

const PLAN_OPERATIONS = new Set([
  'network-arm',
  'network-disarm',
  'camera-motion-set',
  'camera-thumbnail-refresh',
  'clip-watched-mark',
  'clip-delete',
  'camera-live-view-start',
]);

const OPERATION_ALIASES = new Map([
  ['login', 'account-login'],
  ['refresh', 'account-refresh'],
  ['verify-pin', 'pin-verify'],
  ['homescreen', 'devices-list'],
  ['networks', 'networks-list'],
  ['network-status', 'network-status-read'],
  ['sync-modules', 'sync-modules-list'],
  ['cameras', 'cameras-list'],
  ['camera-config', 'camera-config-read'],
  ['camera-signals', 'camera-signals-read'],
  ['doorbells', 'doorbells-list'],
  ['motion-events', 'motion-events-list'],
  ['clips', 'clips-list'],
  ['download-thumbnail', 'thumbnail-download'],
  ['arm-network', 'network-arm'],
  ['disarm-network', 'network-disarm'],
  ['camera-motion', 'camera-motion-set'],
  ['thumbnail', 'camera-thumbnail-refresh'],
  ['mark-clip-watched', 'clip-watched-mark'],
  ['delete-clip', 'clip-delete'],
  ['live-view', 'camera-live-view-start'],
]);

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function printHelp() {
  console.log(`Blink skill helper

Usage:
  node skills/blink/blink.cjs [--format json|pretty] run <operation> [flags]
  node skills/blink/blink.cjs [--format json|pretty] http-request <operation> [flags]
  node skills/blink/blink.cjs [--format json|pretty] plan <operation> [flags]

Read/request commands:
  run account-login [--pin <code>]
  run account-refresh
  run devices-list
  http-request account-login
  http-request account-refresh
  http-request pin-verify --pin <code>
  http-request devices-list
  http-request networks-list
  http-request network-status-read --network <network-id>
  http-request sync-modules-list --network <network-id>
  http-request cameras-list --network <network-id>
  http-request camera-config-read --network <network-id> --camera <camera-id>
  http-request camera-signals-read --network <network-id> --camera <camera-id>
  http-request doorbells-list --network <network-id>
  http-request motion-events-list --network <network-id> [--since 2026-05-26T00:00:00Z]
  http-request clips-list [--network <network-id>] [--since 2026-05-26T00:00:00Z] [--page 0] [--max 50]
  http-request clip-download --path /api/v2/accounts/<account-id>/media/clip/<file.mp4> [--filename clip.mp4]
  http-request thumbnail-download --path /api/v3/media/accounts/<account-id>/networks/<network-id>/<camera-type>/<camera-id>/thumbnail/thumbnail.jpg?ts=<ts>&ext= [--filename camera.jpg]

Guarded operation plans:
  plan network-arm --network <network-id>
  plan network-disarm --network <network-id>
  plan camera-motion-set --network <network-id> --camera <camera-id> --enable true
  plan camera-thumbnail-refresh --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell] [--filename camera.jpg]
  plan clip-watched-mark --clip <clip-id>
  plan clip-delete --clip <clip-id>
  plan camera-live-view-start --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell]

Environment:
  HYBRIDCLAW_GATEWAY_URL   gateway base URL for live execution (default: http://127.0.0.1:9090)
  HYBRIDCLAW_GATEWAY_TOKEN gateway bearer token for live execution
  BLINK_DEVICE_ID     optional generated OAuth v2 hardware id override
  BLINK_CLIENT_NAME   optional local display name, not sent to Blink OAuth v2
  BLINK_USER_AGENT    optional Blink REST User-Agent override
  BLINK_TIER          optional resolved tier, for example e003
  BLINK_ACCOUNT_ID    optional numeric account id fallback
  BLINK_CLIENT_ID     optional numeric client id fallback

Notes:
  Operation names use subject-verb form. Legacy aliases such as login, homescreen,
  cameras, and clips are accepted but canonical output uses account-login,
  devices-list, cameras-list, and clips-list.
  Use run for live gateway execution; use http-request for dry-run JSON.
  clips-list accepts optional --network for issue-contract compatibility, but Blink's media/changed API is account-scoped; use returned clip metadata to filter by network.
  thumbnail-download is for thumbnail paths returned by devices-list; do not rewrite
  those paths onto prod.immedia-semi.com.
  run camera-thumbnail-refresh performs the full approved snapshot workflow:
  trigger the Blink command, poll command status, re-read homescreen, download
  the returned thumbnail as an artifact, and report freshness evidence.
`);
}

function shellQuote(value) {
  const raw = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(raw)) return raw;
  return `'${raw.replace(/'/gu, `'\\''`)}'`;
}

function popFlag(args, name, defaultValue = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return defaultValue;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    die(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function peekFlag(args, name, defaultValue = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return defaultValue;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    die(`${name} requires a value.`);
  }
  return value;
}

function assertNoUnexpectedArgs(args) {
  if (args.length > 0) die(`Unexpected argument: ${args[0]}`);
}

function requireText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function parseIdentifier(value, label) {
  const normalized = requireText(value, label);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(normalized)) {
    die(
      `${label} must be a bounded id using letters, numbers, dot, colon, dash, or underscore.`,
    );
  }
  return normalized;
}

function parseIntegerId(value, label) {
  const normalized = requireText(value, label);
  if (normalized.startsWith('<secret:')) return normalized;
  if (!/^\d{1,18}$/u.test(normalized)) die(`${label} must be a numeric id.`);
  return normalized;
}

function parseBooleanValue(value, label) {
  const normalized = requireText(value, label).toLowerCase();
  if (['true', 'on', '1', 'yes', 'enable', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['false', 'off', '0', 'no', 'disable', 'disabled'].includes(normalized)) {
    return false;
  }
  die(`${label} must be true or false.`);
}

function parseNonNegativeInteger(value, label) {
  const normalized = requireText(value, label);
  if (!/^\d+$/u.test(normalized))
    die(`${label} must be a non-negative integer.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    die(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function parsePositiveInteger(value, label) {
  const parsed = parseNonNegativeInteger(value, label);
  if (parsed < 1) die(`${label} must be greater than zero.`);
  return parsed;
}

function parseSha256(value, label) {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    die(`${label} must be a lowercase or uppercase SHA-256 hex digest.`);
  }
  return normalized;
}

function parseIsoTime(value, label) {
  const normalized = requireText(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(normalized)
  ) {
    die(
      `${label} must be an ISO-8601 UTC timestamp like 2026-05-26T00:00:00Z.`,
    );
  }
  return normalized;
}

function parsePin(value) {
  const normalized = requireText(value, '--pin');
  if (!/^\d{4,8}$/u.test(normalized)) die('--pin must be a 4-8 digit code.');
  return normalized;
}

function parseDeviceId(value, label) {
  const normalized = requireText(value, label);
  if (!/^[A-Za-z0-9_.:-]{1,96}$/u.test(normalized)) {
    die(
      `${label} must be a bounded id using letters, numbers, dot, colon, dash, or underscore.`,
    );
  }
  return normalized;
}

function parseClientName(value, label) {
  const normalized = requireText(value, label);
  if (!/^[A-Za-z0-9_.: -]{1,64}$/u.test(normalized)) {
    die(
      `${label} must be a bounded display name using letters, numbers, space, dot, colon, dash, or underscore.`,
    );
  }
  return normalized;
}

function parseUserAgent(value) {
  const normalized = requireText(value, '--user-agent');
  if (
    normalized.includes('<secret:') ||
    !/^[A-Za-z0-9 .;:/()_-]{8,160}$/u.test(normalized)
  ) {
    die(
      '--user-agent must be a bounded Blink app User-Agent string and must not contain SecretRefs.',
    );
  }
  return normalized;
}

function configureUserAgent(args) {
  userAgent = parseUserAgent(
    popFlag(args, '--user-agent') ||
      process.env.BLINK_USER_AGENT ||
      DEFAULT_USER_AGENT,
  );
}

function generatedDeviceId() {
  const seed = [
    process.env.HYBRIDCLAW_INSTANCE_ID,
    process.env.HYBRIDCLAW_DATA_DIR,
    process.env.HOME,
    os.homedir(),
    os.hostname(),
  ]
    .filter(Boolean)
    .join('|');
  const digest = createHash('sha256')
    .update(seed || 'hybridclaw')
    .digest('hex');
  const uuid = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join('-');
  return `hybridclaw-${uuid}`;
}

function generatedHardwareId() {
  const raw = generatedDeviceId().replace(/^hybridclaw-/u, '');
  return raw.toUpperCase();
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function generatePkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function canonicalOperation(operation) {
  const normalized = String(operation || '').trim();
  return OPERATION_ALIASES.get(normalized) || normalized;
}

function resolveDeviceId(args) {
  return parseDeviceId(
    popFlag(args, '--device-id') ||
      process.env[ENV_NAMES.deviceId] ||
      generatedDeviceId(),
    '--device-id',
  );
}

function resolveClientName(args) {
  return parseClientName(
    popFlag(args, '--client-name') ||
      process.env[ENV_NAMES.clientName] ||
      'hybridclaw',
    '--client-name',
  );
}

function parseCameraType(value) {
  const normalized = String(value || 'default')
    .trim()
    .toLowerCase();
  if (!['default', 'mini', 'doorbell'].includes(normalized)) {
    die('--camera-type must be default, mini, or doorbell.');
  }
  return normalized;
}

function resolveTier(args) {
  const tier =
    popFlag(args, '--tier') ||
    process.env.BLINK_TIER ||
    `<secret:${SECRET_NAMES.tier}>`;
  const normalized = String(tier).trim();
  if (normalized.startsWith('<secret:')) return normalized;
  if (!/^[a-z]\d{3}$/u.test(normalized)) {
    die('--tier must look like e003 or come from BLINK_TIER.');
  }
  return normalized;
}

function restBaseForTier(tier) {
  return `https://rest-${tier}.immedia-semi.com`;
}

function resolveAccountId(args) {
  return parseIntegerId(
    popFlag(args, '--account') ||
      process.env.BLINK_ACCOUNT_ID ||
      `<secret:${SECRET_NAMES.accountId}>`,
    '--account',
  );
}

function resolveClientId(args) {
  return parseIntegerId(
    popFlag(args, '--client') ||
      process.env.BLINK_CLIENT_ID ||
      `<secret:${SECRET_NAMES.clientId}>`,
    '--client',
  );
}

function appendPath(base, path) {
  const url = new URL(base);
  url.pathname = path;
  return url;
}

function appendQueryString(url, entries) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, String(value));
    }
  }
  const query = params.toString();
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

function tierRequestUrl(args, path) {
  const tier = resolveTier(args);
  if (tier.startsWith('<secret:')) {
    return `https://rest-${tier}.immedia-semi.com${path}`;
  }
  return appendPath(restBaseForTier(tier), path).toString();
}

function blinkHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
    ...extra,
  };
}

function authSecretHeaders() {
  return [
    {
      name: 'Authorization',
      secretName: SECRET_NAMES.authToken,
      prefix: 'Bearer',
    },
  ];
}

function resolveGatewayUrl() {
  return String(
    process.env.HYBRIDCLAW_GATEWAY_URL ||
      process.env.GATEWAY_BASE_URL ||
      DEFAULT_GATEWAY_URL,
  ).replace(/\/+$/u, '');
}

function resolveGatewayToken() {
  return String(
    process.env.HYBRIDCLAW_GATEWAY_TOKEN || process.env.GATEWAY_API_TOKEN || '',
  ).trim();
}

function parseJsonMaybe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeGatewayResult(wrapper, fallbackStatus) {
  const status = Number(wrapper.status || fallbackStatus || 0);
  const body = typeof wrapper.body === 'string' ? wrapper.body : '';
  return {
    command: 'live-result',
    ok: wrapper.ok !== false,
    status,
    statusText: wrapper.statusText || '',
    headers: wrapper.headers || {},
    body,
    bodyJson:
      wrapper.json && typeof wrapper.json === 'object'
        ? wrapper.json
        : parseJsonMaybe(body),
    bodyTruncated: wrapper.bodyTruncated === true,
    maxResponseBytes: wrapper.maxResponseBytes,
    bodySuppressed: wrapper.bodySuppressed === true,
    bodyBytes: wrapper.bodyBytes,
    success: wrapper.success === true,
    artifact: wrapper.artifact,
    artifacts: Array.isArray(wrapper.artifacts) ? wrapper.artifacts : undefined,
    captured: wrapper.captured,
  };
}

function gatewayErrorMessage(response, text) {
  const parsed = parseJsonMaybe(text);
  const errorText =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? String(parsed.error || parsed.text || text).trim()
      : String(text || '').trim();
  const prefix = `Gateway proxy returned HTTP ${response.status} for Blink request`;
  if (
    response.status === 400 &&
    /not allowlisted by workspace network policy/u.test(errorText)
  ) {
    return `${prefix}: workspace network policy denied this helper-emitted target. ${errorText}`;
  }
  return errorText ? `${prefix}: ${errorText}` : prefix;
}

function formatTransportError(error) {
  if (!error) return 'unknown error';
  const message = error instanceof Error ? error.message : String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return `${message}${cause}`;
}

async function executeGatewayRequest(httpRequest, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for Blink requests.');
  }
  const gatewayUrl = String(options.gatewayUrl || resolveGatewayUrl()).replace(
    /\/+$/u,
    '',
  );
  const gatewayToken = options.gatewayToken || resolveGatewayToken();
  const headers = { 'Content-Type': 'application/json' };
  if (gatewayToken) headers.Authorization = `Bearer ${gatewayToken}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    (httpRequest.timeoutMs || DEFAULT_TIMEOUT_MS) + GATEWAY_TIMEOUT_BUFFER_MS,
  );
  let response;
  let text = '';
  try {
    try {
      response = await fetchImpl(`${gatewayUrl}/api/http/request`, {
        method: 'POST',
        headers,
        body: JSON.stringify(httpRequest),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        `Gateway proxy request failed before Blink request was sent: ${formatTransportError(
          error,
        )}. Check that the HybridClaw gateway is running and reachable at ${gatewayUrl}.`,
      );
    }
    text = await response.text();
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(gatewayErrorMessage(response, text));
  }
  const parsed = parseJsonMaybe(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      command: 'live-result',
      ok: true,
      status: response.status,
      statusText: response.statusText || '',
      headers: {},
      body: text,
      bodyJson: null,
    };
  }
  const normalized = normalizeGatewayResult(parsed, response.status);
  if (normalized.bodyTruncated) {
    throw new Error(
      `Blink response was truncated by the gateway at ${normalized.maxResponseBytes || 'the configured'} bytes.`,
    );
  }
  if (
    !normalized.ok &&
    (normalized.status < 300 || normalized.status > 399) &&
    !new Set(options.allowedStatuses || []).has(normalized.status)
  ) {
    throw new Error(
      `Blink returned HTTP ${normalized.status || 'error'}: ${
        normalized.body || normalized.statusText
      }`,
    );
  }
  return normalized;
}

function blinkMissingSecretName(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const match = message.match(/Stored secret (BLINK_[A-Z0-9_]+) is not set/u);
  return match?.[1] || '';
}

function blinkMissingSecretResult(operation, secretName) {
  const authStateSecrets = new Set([
    SECRET_NAMES.authToken,
    SECRET_NAMES.tier,
    SECRET_NAMES.accountId,
    SECRET_NAMES.clientId,
    SECRET_NAMES.refreshToken,
  ]);
  if (authStateSecrets.has(secretName)) {
    return {
      command: 'auth-required',
      operation,
      stakesTier: OPERATION_TIERS[operation] || 'green',
      ok: false,
      reason: 'blink-login-required',
      missingSecret: secretName,
      result:
        'Blink email/password can already be stored while session secrets are still missing. Run the helper login flow to capture BLINK_AUTH_TOKEN, BLINK_REFRESH_TOKEN, BLINK_TIER, BLINK_ACCOUNT_ID, and BLINK_CLIENT_ID.',
      nextCommand:
        'node skills/blink/blink.cjs --format json run account-login',
      costMeasurement: COST_MEASUREMENT,
    };
  }
  if (secretName === SECRET_NAMES.email || secretName === SECRET_NAMES.password) {
    return {
      command: 'credentials-required',
      operation,
      stakesTier: OPERATION_TIERS[operation] || 'green',
      ok: false,
      reason: 'blink-primary-credentials-required',
      missingSecret: secretName,
      result:
        'Blink primary credentials are missing from the host runtime secret store. Set them with TUI slash commands, not shell commands in chat.',
      setupCommands: [
        '/secret set BLINK_EMAIL "<account email>"',
        '/secret set BLINK_PASSWORD "<account password>"',
      ],
      costMeasurement: COST_MEASUREMENT,
    };
  }
  return null;
}

function blinkOAuthErrorCause(response) {
  const bodyJson =
    response?.bodyJson && typeof response.bodyJson === 'object'
      ? response.bodyJson
      : parseJsonMaybe(response?.body);
  if (!bodyJson || typeof bodyJson !== 'object' || Array.isArray(bodyJson)) {
    return '';
  }
  return String(bodyJson.error_cause || bodyJson.error || '').trim();
}

function blinkOAuthAuthStopResult(operation, response) {
  const cause = blinkOAuthErrorCause(response);
  if (
    response?.status === 401 &&
    ['invalid_user_credentials', 'session_expired', 'unauthorized'].includes(
      cause,
    )
  ) {
    return {
      command: 'auth-stopped',
      operation,
      stakesTier: OPERATION_TIERS[operation] || 'green',
      ok: false,
      reason:
        cause === 'invalid_user_credentials'
          ? 'blink-invalid-credentials'
          : 'blink-oauth-session-rejected',
      result:
        'Blink rejected the stored primary credentials or OAuth session. Do not retry automatically; ask the operator to verify BLINK_EMAIL and BLINK_PASSWORD in the host secret store.',
      setupCommands: [
        '/secret set BLINK_EMAIL "<account email>"',
        '/secret set BLINK_PASSWORD "<account password>"',
      ],
      costMeasurement: COST_MEASUREMENT,
    };
  }
  if (response?.status === 429) {
    const bodyJson =
      response.bodyJson && typeof response.bodyJson === 'object'
        ? response.bodyJson
        : parseJsonMaybe(response.body);
    const retryAfterSeconds = Number(bodyJson?.next_time_in_secs || 0) || 0;
    return {
      command: 'auth-stopped',
      operation,
      stakesTier: OPERATION_TIERS[operation] || 'green',
      ok: false,
      reason: 'blink-rate-limited',
      retryAfterSeconds,
      result:
        'Blink rate-limited OAuth login attempts. Do not retry until the retry window has elapsed.',
      costMeasurement: COST_MEASUREMENT,
    };
  }
  return null;
}

function buildPayload(
  operation,
  {
    url,
    method = 'GET',
    headers,
    body,
    form,
    json,
    maxResponseBytes,
    captureResponseFields,
    suppressResponseBody,
    responseArtifact,
    artifact,
    handover,
    responseHandling,
  },
) {
  const stakesTier = OPERATION_TIERS[operation];
  const usesStoredAuthToken = headers === undefined;
  const payload = {
    command: 'http-request',
    operation,
    stakesTier,
    httpRequest: {
      url,
      method,
      headers: headers || blinkHeaders(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: maxResponseBytes || 1_000_000,
      replaceSecretPlaceholders: true,
      skillName: SKILL_NAME,
      stakesTier,
    },
    costMeasurement: COST_MEASUREMENT,
    toolCallInstructions:
      'Pass the httpRequest object to the http_request tool as structured JSON. Do not stringify nested fields such as captureResponseFields or secretHeaders.',
  };
  if (usesStoredAuthToken) {
    payload.httpRequest.secretHeaders = authSecretHeaders();
  }
  if (body !== undefined) payload.httpRequest.body = body;
  if (form !== undefined) payload.httpRequest.form = form;
  if (json !== undefined) payload.httpRequest.json = json;
  if (captureResponseFields !== undefined) {
    payload.httpRequest.captureResponseFields = captureResponseFields;
  }
  if (suppressResponseBody === true) {
    payload.httpRequest.suppressResponseBody = true;
  }
  if (responseArtifact !== undefined) {
    payload.httpRequest.responseArtifact = responseArtifact;
  }
  if (artifact !== undefined) payload.artifact = artifact;
  if (handover !== undefined) payload.handover = handover;
  if (responseHandling !== undefined)
    payload.responseHandling = responseHandling;
  return payload;
}

function oauthHeaders(extra = {}) {
  return {
    'User-Agent': OAUTH_BROWSER_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  };
}

function oauthAuthorizeUrl(hardwareId, codeChallenge) {
  const params = new URLSearchParams({
    app_brand: 'blink',
    app_version: OAUTH_APP_VERSION,
    client_id: OAUTH_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    device_brand: 'Apple',
    device_model: 'iPhone16,1',
    device_os_version: '26.1',
    hardware_id: hardwareId,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPE,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitSetCookieHeader);
  return String(value)
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeSetCookies(cookieJar, headers = {}) {
  const setCookie =
    headers['set-cookie'] ||
    headers['Set-Cookie'] ||
    headers['set-cookie'.toLowerCase()];
  for (const cookie of splitSetCookieHeader(setCookie)) {
    const pair = cookie.split(';', 1)[0]?.trim();
    if (!pair || !pair.includes('=')) continue;
    const name = pair.split('=', 1)[0];
    cookieJar.set(name, pair);
  }
}

function cookieHeader(cookieJar) {
  return Array.from(cookieJar.values()).join('; ');
}

function withCookie(headers, cookieJar) {
  const cookie = cookieHeader(cookieJar);
  return cookie ? { ...headers, Cookie: cookie } : headers;
}

function formFields(entries) {
  return Object.fromEntries(entries);
}

function oauthHandoverPath(options = {}) {
  if (options.handoverPath) return String(options.handoverPath);
  if (process.env.BLINK_OAUTH_HANDOVER_FILE) {
    return process.env.BLINK_OAUTH_HANDOVER_FILE;
  }
  const dataDir =
    process.env.HYBRIDCLAW_DATA_DIR ||
    path.join(os.homedir(), '.hybridclaw', 'data');
  return path.join(dataDir, 'skills', 'blink', 'oauth-handover.json');
}

function clearOAuthHandover(options = {}) {
  try {
    fs.rmSync(oauthHandoverPath(options), { force: true });
  } catch {}
}

function verificationSeconds(response) {
  const bodyJson =
    response?.bodyJson && typeof response.bodyJson === 'object'
      ? response.bodyJson
      : parseJsonMaybe(response?.body);
  const seconds = Number(
    bodyJson?.valid_seconds ||
      bodyJson?.validSeconds ||
      bodyJson?.expires_in ||
      0,
  );
  return Number.isFinite(seconds) && seconds > 0
    ? seconds
    : OAUTH_HANDOVER_DEFAULT_SECONDS;
}

function saveOAuthHandover(state, options = {}) {
  const filePath = oauthHandoverPath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function readOAuthHandover(options = {}) {
  const filePath = oauthHandoverPath(options);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (Number(parsed.expiresAt || 0) <= Date.now()) {
    clearOAuthHandover(options);
    return null;
  }
  if (
    parsed.version !== 1 ||
    typeof parsed.csrfToken !== 'string' ||
    typeof parsed.verifier !== 'string' ||
    typeof parsed.hardwareId !== 'string' ||
    !Array.isArray(parsed.cookies)
  ) {
    clearOAuthHandover(options);
    return null;
  }
  return {
    csrfToken: parsed.csrfToken,
    verifier: parsed.verifier,
    hardwareId: parsed.hardwareId,
    cookieJar: new Map(parsed.cookies),
  };
}

function extractCsrfToken(html) {
  const scriptMatch = String(html || '').match(
    /<script[^>]*id=["']oauth-args["'][^>]*>([\s\S]*?)<\/script>/iu,
  );
  if (!scriptMatch) {
    throw new Error('Blink OAuth sign-in page did not include oauth-args.');
  }
  const rawJson = scriptMatch[1].trim();
  const parsed = JSON.parse(rawJson);
  const csrf = parsed?.['csrf-token'];
  if (typeof csrf !== 'string' || !csrf.trim()) {
    throw new Error('Blink OAuth sign-in page did not include csrf-token.');
  }
  return csrf.trim();
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lower) return String(value);
  }
  return '';
}

function extractAuthorizationCode(location) {
  const raw = String(location || '').trim();
  if (!raw) throw new Error('Blink OAuth redirect did not include Location.');
  const parsed = new URL(raw);
  const code = parsed.searchParams.get('code');
  if (!code) {
    throw new Error(
      'Blink OAuth redirect did not include an authorization code.',
    );
  }
  return code;
}

function oauthGatewayRequest({ url, method = 'GET', headers, form }) {
  return {
    url,
    method,
    headers,
    form,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: 1_000_000,
    replaceSecretPlaceholders: true,
    allowManualRedirect: true,
    includeResponseCookies: true,
    skillName: SKILL_NAME,
    stakesTier: OPERATION_TIERS['account-login'],
  };
}

function buildAccountLogin(args) {
  const pin = popFlag(args, '--pin');
  if (pin !== undefined) parsePin(pin);
  assertNoUnexpectedArgs(args);
  return {
    command: 'auth-plan',
    operation: 'account-login',
    stakesTier: OPERATION_TIERS['account-login'],
    liveHelperCommand: [
      'node',
      'skills/blink/blink.cjs',
      '--format',
      'json',
      'run',
      'account-login',
      ...(pin === undefined ? [] : ['--pin', '<F14_PIN>']),
    ],
    result:
      'Blink login is handled by the helper run command using OAuth v2 Authorization Code + PKCE through the HybridClaw gateway. Use the liveHelperCommand; do not call legacy password-login endpoints.',
    flow: {
      type: 'oauth-v2-authorization-code-pkce',
      hosts: ['api.oauth.blink.com', REST_PROD_HOST],
      steps: [
        'Generate PKCE verifier/challenge and hardware id.',
        'Start /oauth/v2/authorize with client_id=ios and redirect_uri=immedia-blink://applinks.blink.com/signin/callback.',
        'Fetch /oauth/v2/signin, preserve cookies outside model context, and extract the csrf-token from the oauth-args script.',
        'Submit credentials with csrf-token; use F14 for the 2FA code if Blink returns a verification challenge.',
        'Read the authorization code from the redirect and exchange it at /oauth/token with grant_type=authorization_code.',
        'Capture access token, refresh token, tier, account id, and client id into the secret store without exposing them to the model.',
      ],
    },
    toolCallInstructions:
      'Run the helper with `run account-login` for live auth. Do not call http_request for legacy Blink login, do not try alternate /api/v3-/api/v6 login paths, do not try OAuth grant_type=password, and do not web-search inside the user task.',
    costMeasurement: COST_MEASUREMENT,
  };
}

function buildAccountRefresh(args) {
  const hardwareId = parseDeviceId(
    popFlag(args, '--device-id') ||
      process.env[ENV_NAMES.deviceId] ||
      generatedHardwareId(),
    '--device-id',
  );
  assertNoUnexpectedArgs(args);
  return buildPayload('account-refresh', {
    url: OAUTH_TOKEN_URL,
    method: 'POST',
    headers: {
      'User-Agent': OAUTH_TOKEN_USER_AGENT,
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    form: formFields([
      ['app_brand', 'blink'],
      ['client_id', OAUTH_CLIENT_ID],
      ['grant_type', 'refresh_token'],
      ['hardware_id', hardwareId],
      ['refresh_token', `<secret:${SECRET_NAMES.refreshToken}>`],
      ['scope', OAUTH_SCOPE],
    ]),
    captureResponseFields: [
      {
        jsonPath: 'access_token',
        secretName: SECRET_NAMES.authToken,
        bindDomain: 'immedia-semi.com',
      },
      {
        jsonPath: 'refresh_token',
        secretName: SECRET_NAMES.refreshToken,
        bindDomain: 'api.oauth.blink.com',
      },
    ],
    maxResponseBytes: 256_000,
  });
}

function buildAuthMetadataCaptureRequest(operation) {
  const stakesTier = OPERATION_TIERS[operation] || 'green';
  return {
    url: `${DEFAULT_REST_BASE}/api/v1/users/tier_info`,
    method: 'GET',
    headers: blinkHeaders(),
    secretHeaders: authSecretHeaders(),
    captureResponseFields: [
      { jsonPath: 'tier', secretName: SECRET_NAMES.tier },
      { jsonPath: 'account_id', secretName: SECRET_NAMES.accountId },
      { jsonPath: 'client_id', secretName: SECRET_NAMES.clientId },
    ],
    captureResponseHeaders: [
      { header: 'client-id', secretName: SECRET_NAMES.clientId },
    ],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: 256_000,
    replaceSecretPlaceholders: true,
    skillName: SKILL_NAME,
    stakesTier,
  };
}

function buildAuthClientCaptureRequest(operation) {
  const stakesTier = OPERATION_TIERS[operation] || 'green';
  return {
    url: tierRequestUrl(
      [],
      `/api/v3/accounts/<secret:${SECRET_NAMES.accountId}>/homescreen`,
    ),
    method: 'GET',
    headers: blinkHeaders(),
    secretHeaders: authSecretHeaders(),
    captureResponseHeaders: [
      { header: 'client-id', secretName: SECRET_NAMES.clientId },
    ],
    suppressResponseBody: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: 2_000_000,
    replaceSecretPlaceholders: true,
    skillName: SKILL_NAME,
    stakesTier,
  };
}

function buildPinVerify(args) {
  const accountId = resolveAccountId(args);
  const clientId = resolveClientId(args);
  const pin = parsePin(popFlag(args, '--pin'));
  assertNoUnexpectedArgs(args);
  return buildPayload('pin-verify', {
    url: tierRequestUrl(
      args,
      `/api/v4/account/${accountId}/client/${clientId}/pin/verify`,
    ),
    method: 'POST',
    json: { pin },
    responseHandling: {
      authStopStatuses: [401, 412],
      success:
        'After a successful verification response, resume the original Blink read or guarded plan request.',
    },
    maxResponseBytes: 64_000,
  });
}

function buildReadOperation(operation, args) {
  if (operation === 'account-login') return buildAccountLogin(args);
  if (operation === 'account-refresh') return buildAccountRefresh(args);
  if (operation === 'pin-verify') return buildPinVerify(args);

  const accountId = resolveAccountId(args);
  const requireNetwork = () =>
    parseIdentifier(popFlag(args, '--network'), '--network');
  let url;
  let artifact;

  if (operation === 'devices-list') {
    url = tierRequestUrl(args, `/api/v3/accounts/${accountId}/homescreen`);
  } else if (operation === 'networks-list') {
    url = tierRequestUrl(args, '/networks');
  } else if (operation === 'network-status-read') {
    const network = requireNetwork();
    url = tierRequestUrl(args, `/network/${network}`);
  } else if (operation === 'sync-modules-list') {
    const network = requireNetwork();
    url = tierRequestUrl(args, `/network/${network}/syncmodules`);
  } else if (operation === 'cameras-list') {
    const network = requireNetwork();
    url = tierRequestUrl(args, `/network/${network}/cameras`);
  } else if (operation === 'camera-config-read') {
    const network = requireNetwork();
    const camera = parseIdentifier(popFlag(args, '--camera'), '--camera');
    url = tierRequestUrl(args, `/network/${network}/camera/${camera}/config`);
  } else if (operation === 'camera-signals-read') {
    const network = requireNetwork();
    const camera = parseIdentifier(popFlag(args, '--camera'), '--camera');
    url = tierRequestUrl(args, `/network/${network}/camera/${camera}/signals`);
  } else if (operation === 'doorbells-list') {
    const network = requireNetwork();
    url = tierRequestUrl(
      args,
      `/api/v1/accounts/${accountId}/networks/${network}/doorbells`,
    );
  } else if (operation === 'motion-events-list') {
    const network = requireNetwork();
    const since = popFlag(args, '--since');
    url = appendQueryString(
      tierRequestUrl(args, `/events/network/${network}`),
      since === undefined ? {} : { since: parseIsoTime(since, '--since') },
    );
  } else if (operation === 'clips-list') {
    const network = popFlag(args, '--network');
    const networkFilter = network
      ? parseIdentifier(network, '--network')
      : undefined;
    const since = parseIsoTime(
      popFlag(args, '--since', '1970-01-01T00:00:00Z'),
      '--since',
    );
    const page = parseNonNegativeInteger(
      popFlag(args, '--page', '0'),
      '--page',
    );
    const max = parsePositiveInteger(popFlag(args, '--max', '50'), '--max');
    url = appendQueryString(
      tierRequestUrl(args, `/api/v1/accounts/${accountId}/media/changed`),
      { since, page },
    );
    artifact = {
      mode: 'metadata-only',
      clipDownload:
        'Use http-request clip-download for a selected clip path and route the response through the gateway artifact path; never inline raw video bytes.',
      maxItems: max,
      scope: 'account',
      ...(networkFilter
        ? {
            requestedNetwork: networkFilter,
            networkFilter:
              'Blink media/changed is account-scoped; filter returned clip metadata by this network id before summarizing.',
          }
        : {}),
    };
  } else if (operation === 'clip-download') {
    const clipPath = parseClipPath(popFlag(args, '--path'));
    const filename = popFlag(args, '--filename');
    url = tierRequestUrl(args, clipPath);
    artifact = {
      mode: 'gateway-artifact',
      maxInlineBytes: 0,
      responseArtifact: responseArtifactForPath(clipPath, filename),
      handling:
        'Return an artifact handle only; do not include raw video bytes in model context.',
    };
  } else if (operation === 'thumbnail-download') {
    const thumbnailPath = parseThumbnailPath(popFlag(args, '--path'));
    const filename = popFlag(args, '--filename');
    url = tierRequestUrl(args, thumbnailPath);
    artifact = {
      mode: 'gateway-artifact',
      maxInlineBytes: 0,
      responseArtifact: responseArtifactForPath(thumbnailPath, filename),
      handling:
        'Return an artifact handle only; do not include raw image bytes in model context.',
    };
  } else {
    die(
      `Unsupported Blink http-request operation: ${operation || '(missing)'}`,
    );
  }

  assertNoUnexpectedArgs(args);
  return buildPayload(operation, {
    url,
    method: 'GET',
    maxResponseBytes:
      operation === 'clip-download'
        ? 50_000_000
        : operation === 'thumbnail-download'
          ? 5_000_000
          : 2_000_000,
    suppressResponseBody:
      operation === 'clip-download' || operation === 'thumbnail-download',
    responseArtifact:
      artifact && artifact.responseArtifact ? artifact.responseArtifact : undefined,
    artifact,
  });
}

function parseHttpRequestTarget(rawUrl) {
  const match = String(rawUrl).match(/^https:\/\/([^/]+)(\/[^?#]*)/u);
  if (!match) die(`Invalid helper-emitted URL: ${rawUrl}`);
  return {
    host: match[1],
    path: match[2],
  };
}

function normalizeMediaDownloadPath(value) {
  const normalized = requireText(value, '--path');
  if (!normalized.startsWith('/') || normalized.includes('..')) {
    die('--path must be a Blink media path and must not contain traversal.');
  }
  let parsed;
  try {
    parsed = new URL(`https://blink.local${normalized}`);
  } catch {
    die('--path must be a valid Blink media path.');
  }
  return `${parsed.pathname}${parsed.search}`;
}

function parseClipPath(value) {
  const normalized = normalizeMediaDownloadPath(value);
  const parsed = new URL(`https://blink.local${normalized}`);
  const pathPattern =
    /^\/api\/v2\/accounts\/(?:\d+|<secret:BLINK_ACCOUNT_ID>)\/media\/(?:clip|thumb)\/[A-Za-z0-9_.%/-]+$/u;
  if (!pathPattern.test(parsed.pathname) || parsed.search) {
    die(
      '--path must be a Blink clip/thumb path under /api/v2/accounts/<account-id>/media/clip/ or /media/thumb/.',
    );
  }
  return normalized;
}

function parseThumbnailPath(value) {
  const normalized = normalizeMediaDownloadPath(value);
  const parsed = new URL(`https://blink.local${normalized}`);
  const pathPattern =
    /^\/api\/v3\/media\/accounts\/(?:\d+|<secret:BLINK_ACCOUNT_ID>)\/networks\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/thumbnail\/thumbnail\.jpg$/u;
  if (!pathPattern.test(parsed.pathname)) {
    die(
      '--path must be a Blink thumbnail path returned by devices-list under /api/v3/media/accounts/<account-id>/networks/<network-id>/<camera-type>/<camera-id>/thumbnail/thumbnail.jpg.',
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (key !== 'ts' && key !== 'ext') {
      die('--path thumbnail query may only include ts and ext.');
    }
  }
  return normalized;
}

function responseArtifactForPath(mediaPath, filename) {
  const parsed = new URL(`https://blink.local${mediaPath}`);
  return {
    filename: filename || path.basename(parsed.pathname) || 'blink-media',
  };
}

const CAMERA_ACTION_PATHS = {
  mini: {
    motion: ({ accountId, network, camera, enable }) => ({
      path: `/api/v1/accounts/${accountId}/networks/${network}/owls/${camera}/config`,
      json: { enabled: enable },
    }),
    thumbnail: ({ accountId, network, camera }) => ({
      path: `/api/v1/accounts/${accountId}/networks/${network}/owls/${camera}/thumbnail`,
    }),
    liveview: ({ accountId, network, camera }) => ({
      path: `/api/v1/accounts/${accountId}/networks/${network}/owls/${camera}/liveview`,
      json: { intent: 'liveview' },
    }),
  },
  doorbell: {
    motion: ({ accountId, network, camera, enable }) => ({
      path: `/api/v1/accounts/${accountId}/networks/${network}/doorbells/${camera}/${enable ? 'enable' : 'disable'}`,
    }),
    thumbnail: ({ accountId, network, camera }) => ({
      path: `/api/v1/accounts/${accountId}/networks/${network}/doorbells/${camera}/thumbnail`,
    }),
    liveview: ({ accountId, network, camera }) => ({
      path: `/api/v1/accounts/${accountId}/networks/${network}/doorbells/${camera}/liveview`,
      json: { intent: 'liveview' },
    }),
  },
  default: {
    motion: ({ network, camera, enable }) => ({
      path: `/network/${network}/camera/${camera}/${enable ? 'enable' : 'disable'}`,
    }),
    thumbnail: ({ network, camera }) => ({
      path: `/network/${network}/camera/${camera}/thumbnail`,
    }),
    liveview: ({ accountId, network, camera }) => ({
      path: `/api/v5/accounts/${accountId}/networks/${network}/cameras/${camera}/liveview`,
      json: { intent: 'liveview' },
    }),
  },
};

function cameraActionPath({
  accountId,
  network,
  camera,
  cameraType,
  action,
  enable,
}) {
  const actionBuilder = CAMERA_ACTION_PATHS[cameraType]?.[action];
  if (!actionBuilder) {
    die(`Unsupported Blink camera action: ${cameraType}/${action}`);
  }
  return actionBuilder({ accountId, network, camera, enable });
}

function requireOperatorGrant(args, operation) {
  const index = args.indexOf('--operator-grant');
  if (index === -1) {
    die(
      `${operation} is ${OPERATION_TIERS[operation]}; pass --operator-grant only after exact F8/F14 operator approval.`,
    );
  }
  args.splice(index, 1);
}

function buildMutationRequest(operation, args, options = {}) {
  if (options.requireGrant) requireOperatorGrant(args, operation);
  const accountId = resolveAccountId(args);
  let target;
  let json;
  let approvalDetails;

  if (operation === 'network-arm' || operation === 'network-disarm') {
    const network = parseIdentifier(popFlag(args, '--network'), '--network');
    target = `/api/v1/accounts/${accountId}/networks/${network}/state/${operation === 'network-arm' ? 'arm' : 'disarm'}`;
    approvalDetails = {
      action:
        operation === 'network-arm'
          ? 'arm Blink network'
          : 'disarm Blink network',
      network,
    };
  } else if (operation === 'camera-motion-set') {
    const network = parseIdentifier(popFlag(args, '--network'), '--network');
    const camera = parseIdentifier(popFlag(args, '--camera'), '--camera');
    const enable = parseBooleanValue(popFlag(args, '--enable'), '--enable');
    const cameraType = parseCameraType(
      popFlag(args, '--camera-type', 'default'),
    );
    const action = cameraActionPath({
      accountId,
      network,
      camera,
      cameraType,
      action: 'motion',
      enable,
    });
    target = action.path;
    json = action.json;
    approvalDetails = {
      action: enable
        ? 'enable Blink camera motion detection'
        : 'disable Blink camera motion detection',
      network,
      camera,
      cameraType,
    };
  } else if (
    operation === 'camera-thumbnail-refresh' ||
    operation === 'camera-live-view-start'
  ) {
    const filename =
      operation === 'camera-thumbnail-refresh'
        ? popFlag(args, '--filename')
        : undefined;
    const network = parseIdentifier(popFlag(args, '--network'), '--network');
    const camera = parseIdentifier(popFlag(args, '--camera'), '--camera');
    const cameraType = parseCameraType(
      popFlag(args, '--camera-type', 'default'),
    );
    const action = cameraActionPath({
      accountId,
      network,
      camera,
      cameraType,
      action:
        operation === 'camera-thumbnail-refresh' ? 'thumbnail' : 'liveview',
    });
    target = action.path;
    json = action.json;
    approvalDetails = {
      action:
        operation === 'camera-thumbnail-refresh'
          ? 'trigger Blink camera thumbnail snapshot'
          : 'start Blink camera live view',
      network,
      camera,
      cameraType,
      filename,
    };
  } else if (operation === 'clip-watched-mark') {
    const clip = parseIdentifier(popFlag(args, '--clip'), '--clip');
    target = `/api/v1/accounts/${accountId}/media/${clip}/watched`;
    approvalDetails = {
      action: 'mark Blink clip watched',
      clip,
    };
  } else if (operation === 'clip-delete') {
    const clip = parseIdentifier(popFlag(args, '--clip'), '--clip');
    target = `/api/v1/accounts/${accountId}/media/delete`;
    json = { media: [clip] };
    approvalDetails = {
      action: 'delete Blink clip',
      clip,
    };
  } else {
    die(`Unsupported Blink plan operation: ${operation || '(missing)'}`);
  }

  const url = tierRequestUrl(args, target);
  assertNoUnexpectedArgs(args);
  const payloadOptions = {
    url,
    method: 'POST',
    json,
    maxResponseBytes: 512_000,
  };
  if (operation === 'camera-live-view-start') {
    payloadOptions.suppressResponseBody = true;
    payloadOptions.artifact = {
      mode: 'operator-ui-only',
      maxInlineBytes: 0,
      handling:
        'Live-view RTSP/HLS/session handles must stay out of model context. The gateway suppresses the response body; surface only an operator-facing UI handle.',
    };
    payloadOptions.responseHandling = {
      opaqueResult: true,
      suppressesInlineBody: true,
      allowedSurface: 'operator-facing UI only',
    };
  }
  return {
    payload: buildPayload(operation, payloadOptions),
    approvalDetails,
  };
}

function buildPlan(operation, args) {
  if (!PLAN_OPERATIONS.has(operation)) {
    die(`Unsupported Blink plan operation: ${operation || '(missing)'}`);
  }
  const originalArgs = [...args];
  const { payload, approvalDetails } = buildMutationRequest(operation, args);
  const helperCommand = [
    'node',
    'skills/blink/blink.cjs',
    '--format',
    'json',
    operation === 'camera-thumbnail-refresh' ? 'run' : 'http-request',
    operation,
    ...originalArgs,
    '--operator-grant',
  ];
  const target = parseHttpRequestTarget(payload.httpRequest.url);
  const plan = {
    command: 'approval-plan',
    operation,
    stakesTier: payload.stakesTier,
    approvalRequired: true,
    approvalRoute: 'f14',
    approvalBoundary:
      'Stop after producing this plan. Do not run approvedHelperCommandText until the operator confirms this exact Blink privacy-sensitive action in a later message.',
    approvalText: [
      `Approve ${approvalDetails.action}.`,
      approvalDetails.network ? `Network: ${approvalDetails.network}.` : '',
      approvalDetails.camera ? `Camera: ${approvalDetails.camera}.` : '',
      approvalDetails.cameraType
        ? `Camera type: ${approvalDetails.cameraType}.`
        : '',
      approvalDetails.clip ? `Clip: ${approvalDetails.clip}.` : '',
      `Method: ${payload.httpRequest.method}.`,
      `Path: ${target.path}.`,
    ]
      .filter(Boolean)
      .join(' '),
    approvedHelperCommand: helperCommand,
    approvedHelperCommandText: helperCommand.map(shellQuote).join(' '),
    target: {
      host: target.host,
      path: target.path,
      method: payload.httpRequest.method,
    },
    httpRequest: payload.httpRequest,
  };
  if (payload.httpRequest.json !== undefined)
    plan.json = payload.httpRequest.json;
  if (payload.artifact !== undefined) plan.artifact = payload.artifact;
  if (payload.responseHandling !== undefined)
    plan.responseHandling = payload.responseHandling;
  return plan;
}

function liveRequestSummary(httpRequest) {
  return {
    url: httpRequest.url,
    method: httpRequest.method,
  };
}

async function runAccountLogin(args, options = {}) {
  try {
    return await runAccountLoginFlow(args, options);
  } catch (error) {
    const missingSecret = blinkMissingSecretName(error);
    const missingResult = missingSecret
      ? blinkMissingSecretResult('account-login', missingSecret)
      : null;
    if (missingResult) return missingResult;
    throw error;
  }
}

async function runAccountLoginFlow(args, options = {}) {
  const pin = popFlag(args, '--pin');
  const parsedPin = pin === undefined ? undefined : parsePin(pin);
  const hardwareId = parseDeviceId(
    popFlag(args, '--device-id') ||
      process.env[ENV_NAMES.deviceId] ||
      generatedHardwareId(),
    '--device-id',
  );
  assertNoUnexpectedArgs(args);

  if (parsedPin) {
    const pending = readOAuthHandover(options);
    if (pending) {
      return await completeAccountLoginAfter2fa(
        {
          parsedPin,
          csrfToken: pending.csrfToken,
          verifier: pending.verifier,
          hardwareId: pending.hardwareId,
          cookieJar: pending.cookieJar,
        },
        options,
      );
    }
  }

  const { verifier, challenge } = generatePkcePair();
  const authorizeUrl = oauthAuthorizeUrl(hardwareId, challenge);
  const cookieJar = new Map();

  let response = await executeGatewayRequest(
    oauthGatewayRequest({
      url: authorizeUrl,
      headers: oauthHeaders(),
    }),
    options,
  );
  mergeSetCookies(cookieJar, response.headers);
  if (
    response.status !== 200 &&
    (response.status < 300 || response.status > 399)
  ) {
    throw new Error(`Blink OAuth authorize returned HTTP ${response.status}.`);
  }

  response = await executeGatewayRequest(
    oauthGatewayRequest({
      url: OAUTH_SIGNIN_URL,
      headers: withCookie(oauthHeaders(), cookieJar),
    }),
    options,
  );
  mergeSetCookies(cookieJar, response.headers);
  if (response.status !== 200) {
    throw new Error(`Blink OAuth sign-in page returned HTTP ${response.status}.`);
  }
  const csrfToken = extractCsrfToken(response.body);

  response = await executeGatewayRequest(
    oauthGatewayRequest({
      url: OAUTH_SIGNIN_URL,
      method: 'POST',
      headers: withCookie(
        oauthHeaders({
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: OAUTH_BASE_URL,
          Referer: OAUTH_SIGNIN_URL,
        }),
        cookieJar,
      ),
      form: formFields([
        ['username', `<secret:${SECRET_NAMES.email}>`],
        ['password', `<secret:${SECRET_NAMES.password}>`],
        ['csrf-token', csrfToken],
      ]),
    }),
    { ...options, allowedStatuses: [401, 412, 429] },
  );
  mergeSetCookies(cookieJar, response.headers);
  const authStop = blinkOAuthAuthStopResult('account-login', response);
  if (authStop) {
    clearOAuthHandover(options);
    return authStop;
  }

  if (response.status === 412) {
    if (!parsedPin) {
      const seconds = verificationSeconds(response);
      saveOAuthHandover(
        {
          version: 1,
          createdAt: Date.now(),
          expiresAt: Date.now() + seconds * 1000,
          csrfToken,
          verifier,
          hardwareId,
          cookies: Array.from(cookieJar.entries()),
        },
        options,
      );
      return {
        command: 'handover-required',
        operation: 'account-login',
        stakesTier: OPERATION_TIERS['account-login'],
        route: 'f14',
        reason: 'blink-2fa-required',
        expiresInSeconds: seconds,
        result:
          'Blink requested an email/SMS verification PIN. Ask the operator for the PIN via F14, then run the resumeCommand.',
        resumeCommand: [
          'node',
          'skills/blink/blink.cjs',
          '--format',
          'json',
          'run',
          'account-login',
          '--pin',
          '<code>',
        ],
        costMeasurement: COST_MEASUREMENT,
      };
    }

    return await completeAccountLoginAfter2fa(
      { parsedPin, csrfToken, verifier, hardwareId, cookieJar },
      options,
    );
  } else if (response.status < 300 || response.status > 399) {
    throw new Error(`Blink OAuth sign-in returned HTTP ${response.status}.`);
  }

  return await captureAccountLoginTokens(
    { verifier, hardwareId, cookieJar },
    options,
  );
}

async function completeAccountLoginAfter2fa(
  { parsedPin, csrfToken, verifier, hardwareId, cookieJar },
  options,
) {
  const response = await executeGatewayRequest(
    oauthGatewayRequest({
      url: OAUTH_2FA_VERIFY_URL,
      method: 'POST',
      headers: withCookie(
        oauthHeaders({
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: OAUTH_BASE_URL,
          Referer: OAUTH_SIGNIN_URL,
        }),
        cookieJar,
      ),
      form: formFields([
        ['2fa_code', parsedPin],
        ['csrf-token', csrfToken],
        ['remember_me', 'false'],
      ]),
    }),
    options,
  );
  mergeSetCookies(cookieJar, response.headers);
  if (response.status !== 201 || response.bodyJson?.status !== 'auth-completed') {
    throw new Error(`Blink 2FA verification returned HTTP ${response.status}.`);
  }
  return await captureAccountLoginTokens(
    { verifier, hardwareId, cookieJar },
    options,
  );
}

async function captureAccountLoginTokens({ verifier, hardwareId, cookieJar }, options) {
  let response = await executeGatewayRequest(
    oauthGatewayRequest({
      url: OAUTH_AUTHORIZE_URL,
      headers: withCookie(
        oauthHeaders({
          Accept: '*/*',
          Referer: OAUTH_SIGNIN_URL,
        }),
        cookieJar,
      ),
    }),
    options,
  );
  mergeSetCookies(cookieJar, response.headers);
  if (response.status < 300 || response.status > 399) {
    throw new Error(
      `Blink OAuth authorization-code redirect returned HTTP ${response.status}.`,
    );
  }
  const code = extractAuthorizationCode(headerValue(response.headers, 'location'));

  const tokenRequest = {
    url: OAUTH_TOKEN_URL,
    method: 'POST',
    headers: {
      'User-Agent': OAUTH_TOKEN_USER_AGENT,
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    form: formFields([
      ['app_brand', 'blink'],
      ['client_id', OAUTH_CLIENT_ID],
      ['code', code],
      ['code_verifier', verifier],
      ['grant_type', 'authorization_code'],
      ['hardware_id', hardwareId],
      ['redirect_uri', OAUTH_REDIRECT_URI],
      ['scope', OAUTH_SCOPE],
    ]),
    captureResponseFields: [
      {
        jsonPath: 'access_token',
        secretName: SECRET_NAMES.authToken,
        bindDomain: 'immedia-semi.com',
      },
      {
        jsonPath: 'refresh_token',
        secretName: SECRET_NAMES.refreshToken,
        bindDomain: 'api.oauth.blink.com',
      },
    ],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: 256_000,
    replaceSecretPlaceholders: true,
    skillName: SKILL_NAME,
    stakesTier: OPERATION_TIERS['account-login'],
  };
  const tokenResult = await executeGatewayRequest(tokenRequest, options);

  const tierRequest = buildAuthMetadataCaptureRequest('account-login');
  const tierResult = await executeGatewayRequest(tierRequest, options);
  const clientRequest = buildAuthClientCaptureRequest('account-login');
  const clientResult = await executeGatewayRequest(clientRequest, options);
  clearOAuthHandover(options);

  return {
    command: 'live-auth',
    operation: 'account-login',
    stakesTier: OPERATION_TIERS['account-login'],
    request: {
      auth: { url: OAUTH_AUTHORIZE_URL, method: 'GET/POST' },
      token: liveRequestSummary(tokenRequest),
      tier: liveRequestSummary(tierRequest),
      client: liveRequestSummary(clientRequest),
    },
    result: {
      ok: true,
      tokenCaptured: tokenResult.captured || {},
      tierCaptured: tierResult.captured || {},
      clientCaptured: clientResult.captured || {},
      nextCommand:
        'node skills/blink/blink.cjs --format json run devices-list',
    },
    costMeasurement: COST_MEASUREMENT,
  };
}

async function runAccountRefresh(args, options = {}) {
  try {
    return await runAccountRefreshFlow(args, options);
  } catch (error) {
    const missingSecret = blinkMissingSecretName(error);
    const missingResult = missingSecret
      ? blinkMissingSecretResult('account-refresh', missingSecret)
      : null;
    if (missingResult) return missingResult;
    throw error;
  }
}

async function runAccountRefreshFlow(args, options = {}) {
  const payload = buildAccountRefresh(args);
  const refreshResult = await executeGatewayRequest(
    payload.httpRequest,
    options,
  );
  const tierResult = await executeGatewayRequest(
    buildAuthMetadataCaptureRequest('account-refresh'),
    options,
  );
  const clientResult = await executeGatewayRequest(
    buildAuthClientCaptureRequest('account-refresh'),
    options,
  );
  const tierRequest = buildAuthMetadataCaptureRequest('account-refresh');
  const clientRequest = buildAuthClientCaptureRequest('account-refresh');
  return {
    command: 'live-auth',
    operation: 'account-refresh',
    stakesTier: OPERATION_TIERS['account-refresh'],
    request: {
      refresh: liveRequestSummary(payload.httpRequest),
      tier: liveRequestSummary(tierRequest),
      client: liveRequestSummary(clientRequest),
    },
    result: {
      ok: true,
      refreshCaptured: refreshResult.captured || {},
      tierCaptured: tierResult.captured || {},
      clientCaptured: clientResult.captured || {},
      nextCommand:
        'node skills/blink/blink.cjs --format json run devices-list',
    },
    costMeasurement: COST_MEASUREMENT,
  };
}

async function executeLivePayload(payload, options = {}, didRecoverAuth = false) {
  try {
    return {
      command: 'live',
      operation: payload.operation,
      stakesTier: payload.stakesTier,
      request: liveRequestSummary(payload.httpRequest),
      result: await executeGatewayRequest(payload.httpRequest, options),
      costMeasurement: payload.costMeasurement,
    };
  } catch (error) {
    const missingSecret = blinkMissingSecretName(error);
    if (
      !didRecoverAuth &&
      [
        SECRET_NAMES.tier,
        SECRET_NAMES.accountId,
        SECRET_NAMES.clientId,
      ].includes(missingSecret)
    ) {
      try {
        await runAccountRefreshFlow([], options);
        return executeLivePayload(payload, options, true);
      } catch (recoveryError) {
        const recoveryMissingSecret = blinkMissingSecretName(recoveryError);
        const recoveryMissingResult = recoveryMissingSecret
          ? blinkMissingSecretResult(payload.operation, recoveryMissingSecret)
          : null;
        if (recoveryMissingResult) return recoveryMissingResult;
        throw recoveryError;
      }
    }
    const missingResult = missingSecret
      ? blinkMissingSecretResult(payload.operation, missingSecret)
      : null;
    if (missingResult) return missingResult;
    throw error;
  }
}

function parseThumbnailRefreshRunOptions(args) {
  return {
    network: parseIdentifier(peekFlag(args, '--network'), '--network'),
    camera: parseIdentifier(peekFlag(args, '--camera'), '--camera'),
    cameraType: parseCameraType(peekFlag(args, '--camera-type', 'default')),
    filename: popFlag(args, '--filename'),
    previousSha256:
      args.includes('--previous-sha256')
        ? parseSha256(popFlag(args, '--previous-sha256'), '--previous-sha256')
        : undefined,
    maxWaitMs: parsePositiveInteger(
      popFlag(args, '--max-wait-ms', String(DEFAULT_THUMBNAIL_WAIT_MS)),
      '--max-wait-ms',
    ),
    pollIntervalMs: parsePositiveInteger(
      popFlag(
        args,
        '--poll-interval-ms',
        String(DEFAULT_COMMAND_POLL_INTERVAL_MS),
      ),
      '--poll-interval-ms',
    ),
  };
}

function extractBlinkCommand(response) {
  const body = response?.bodyJson;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const commandId = body.id ?? body.command_id ?? body.commandId;
  const networkId = body.network_id ?? body.networkId;
  if (commandId === undefined || commandId === null) return null;
  return {
    id: parseIdentifier(String(commandId), 'command id'),
    network:
      networkId === undefined || networkId === null
        ? ''
        : parseIdentifier(String(networkId), 'command network id'),
  };
}

function buildCommandStatusRequest(operation, network, commandId, args = []) {
  return buildPayload(operation, {
    url: tierRequestUrl(args, `/network/${network}/command/${commandId}`),
    method: 'GET',
    maxResponseBytes: 256_000,
  }).httpRequest;
}

function isCommandComplete(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.complete === true) return true;
  if (String(body.status || '').toLowerCase() === 'done') return true;
  const commandStates = Array.isArray(body.commands)
    ? body.commands
        .map((command) =>
          String(command?.state_condition || command?.stateCondition || ''),
        )
        .map((state) => state.toLowerCase())
    : [];
  return commandStates.some((state) => state === 'done' || state === 'complete');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollBlinkCommand(
  operation,
  network,
  commandId,
  { maxWaitMs, pollIntervalMs },
  options,
) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastResult = null;
  while (Date.now() - startedAt <= maxWaitMs) {
    attempts += 1;
    lastResult = await executeGatewayRequest(
      buildCommandStatusRequest(operation, network, commandId),
      options,
    );
    if (isCommandComplete(lastResult.bodyJson)) {
      return {
        ok: true,
        attempts,
        elapsedMs: Date.now() - startedAt,
        result: lastResult,
      };
    }
    await sleep(pollIntervalMs);
  }
  return {
    ok: false,
    attempts,
    elapsedMs: Date.now() - startedAt,
    result: lastResult,
  };
}

function cameraMatches(candidate, { network, camera, cameraType }) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  const id = candidate.id ?? candidate.camera_id ?? candidate.cameraId;
  const networkId = candidate.network_id ?? candidate.networkId;
  if (String(id ?? '') !== String(camera)) return false;
  if (networkId !== undefined && String(networkId) !== String(network)) {
    return false;
  }
  if (cameraType !== 'default' && candidate.type !== undefined) {
    const candidateType = String(candidate.type);
    const acceptedTypes =
      cameraType === 'mini' ? new Set(['mini', 'owl']) : new Set([cameraType]);
    if (!acceptedTypes.has(candidateType)) return false;
  }
  return true;
}

function findCameraWithThumbnail(value, target) {
  const queue = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (cameraMatches(current, target) && typeof current.thumbnail === 'string') {
      return current;
    }
    if (Array.isArray(current)) {
      queue.push(...current);
    } else {
      queue.push(...Object.values(current));
    }
  }
  return null;
}

function thumbnailTimestamp(thumbnailPath) {
  try {
    const parsed = new URL(`https://blink.local${thumbnailPath}`);
    const raw = parsed.searchParams.get('ts');
    return raw && /^\d+$/u.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

function freshnessEvidence({
  commandPoll,
  previousThumbnailPath,
  camera,
  thumbnailPath,
  downloadResult,
  previousSha256,
}) {
  const artifactSha = String(downloadResult?.artifact?.sha256 || '').toLowerCase();
  const timestamp = thumbnailTimestamp(thumbnailPath);
  const updatedAt = String(camera?.updated_at || camera?.updatedAt || '');
  const sameAsPrevious =
    previousSha256 !== undefined && artifactSha === previousSha256;
  const thumbnailPathChanged =
    previousThumbnailPath === undefined || previousThumbnailPath !== thumbnailPath;
  return {
    ok: commandPoll.ok && thumbnailPathChanged && !sameAsPrevious,
    reason:
      commandPoll.ok && thumbnailPathChanged && !sameAsPrevious
        ? 'fresh-thumbnail'
        : 'thumbnail-unchanged',
    commandCompleted: commandPoll.ok,
    commandPollAttempts: commandPoll.attempts,
    cameraStatus: camera?.status,
    cameraUpdatedAt: updatedAt || undefined,
    previousThumbnailPath,
    thumbnailPath,
    thumbnailPathChanged,
    thumbnailTs: timestamp ?? undefined,
    artifactSha256: artifactSha || undefined,
    downloadStatus: downloadResult?.status,
    previousSha256,
    sameAsPrevious,
    warning:
      sameAsPrevious || !thumbnailPathChanged
        ? 'Blink accepted the snapshot command, but the returned thumbnail did not change. Do not describe this as a fresh image.'
        : undefined,
    cause:
      sameAsPrevious || !thumbnailPathChanged
        ? 'unknown; do not infer Wi-Fi, camera reachability, or Blink service state from unchanged thumbnail evidence alone'
        : undefined,
  };
}

function thumbnailRefreshDisplay(evidence, downloadResult) {
  if (!evidence.ok) {
    return {
      shouldDisplayArtifact: false,
      reason: 'stale-thumbnail-withheld',
      guidance:
        'Do not display or link the downloaded thumbnail artifact because Blink returned the same thumbnail after refresh. Report only the freshness failure and the unknown cause.',
      downloadedArtifactSha256:
        typeof downloadResult?.artifact?.sha256 === 'string'
          ? downloadResult.artifact.sha256
          : undefined,
    };
  }
  return {
    shouldDisplayArtifact: true,
    artifact: downloadResult.artifact,
    artifacts: downloadResult.artifacts,
    guidance:
      'Display the artifact only because the helper verified a changed thumbnail after the approved refresh command.',
  };
}

function cameraSummary(camera) {
  if (!camera || typeof camera !== 'object') return undefined;
  return {
    id: camera.id ?? camera.camera_id ?? camera.cameraId,
    name: camera.name,
    networkId: camera.network_id ?? camera.networkId,
    type: camera.type,
    status: camera.status,
    updatedAt: camera.updated_at ?? camera.updatedAt,
  };
}

async function runCameraThumbnailRefresh(args, options = {}) {
  const runOptions = parseThumbnailRefreshRunOptions(args);
  const beforeDevicesPayload = buildReadOperation('devices-list', []);
  const beforeDevicesResult = await executeGatewayRequest(
    beforeDevicesPayload.httpRequest,
    options,
  );
  const beforeCamera = findCameraWithThumbnail(
    beforeDevicesResult.bodyJson,
    runOptions,
  );
  const previousThumbnailPath =
    typeof beforeCamera?.thumbnail === 'string'
      ? parseThumbnailPath(beforeCamera.thumbnail)
      : undefined;
  const mutationPayload = buildMutationRequest('camera-thumbnail-refresh', args, {
    requireGrant: true,
  }).payload;
  const triggerResult = await executeGatewayRequest(
    mutationPayload.httpRequest,
    options,
  );
  const command = extractBlinkCommand(triggerResult);
  const commandPoll = command
    ? await pollBlinkCommand(
        'camera-thumbnail-refresh',
        command.network || runOptions.network,
        command.id,
        runOptions,
        options,
      )
    : {
        ok: false,
        attempts: 0,
        elapsedMs: 0,
        result: null,
      };
  const devicesPayload = buildReadOperation('devices-list', []);
  if (!commandPoll.ok) {
    return {
      command: 'live',
      operation: 'camera-thumbnail-refresh',
      stakesTier: OPERATION_TIERS['camera-thumbnail-refresh'],
      request: {
        beforeDevices: liveRequestSummary(beforeDevicesPayload.httpRequest),
        trigger: liveRequestSummary(mutationPayload.httpRequest),
        commandStatus: command
          ? liveRequestSummary(
              buildCommandStatusRequest(
                'camera-thumbnail-refresh',
                command.network || runOptions.network,
                command.id,
              ),
            )
          : undefined,
      },
      result: {
        ok: false,
        trigger: triggerResult.bodyJson || {
          status: triggerResult.status,
          statusText: triggerResult.statusText,
        },
        commandPoll,
        camera: cameraSummary(beforeCamera),
        freshness: {
          ok: false,
          reason: 'command-not-completed',
          commandCompleted: false,
          commandPollAttempts: commandPoll.attempts,
          previousThumbnailPath,
          warning:
            'Blink accepted the snapshot command, but command status did not report completion before the wait timeout. Do not download or display the previous thumbnail.',
          cause:
            'unknown; command status never reached complete:true, so do not infer Wi-Fi, camera reachability, or Blink service state from this evidence alone',
        },
        display: {
          shouldDisplayArtifact: false,
          reason: 'refresh-command-not-completed',
          guidance:
            'Do not download, display, or link a thumbnail artifact because Blink did not report command completion.',
        },
      },
      artifact: {
        mode: 'no-artifact-command-incomplete',
        maxInlineBytes: 0,
        handling:
          'Do not return or display a thumbnail artifact because the refresh command did not complete.',
      },
      costMeasurement: COST_MEASUREMENT,
    };
  }
  const devicesResult = await executeGatewayRequest(
    devicesPayload.httpRequest,
    options,
  );
  const camera = findCameraWithThumbnail(devicesResult.bodyJson, runOptions);
  if (!camera) {
    throw new Error(
      `Blink homescreen did not include camera ${runOptions.camera} with a thumbnail after refresh.`,
    );
  }
  const thumbnailPath = parseThumbnailPath(camera.thumbnail);
  const downloadPayload = buildReadOperation('thumbnail-download', [
    '--path',
    thumbnailPath,
    ...(runOptions.filename ? ['--filename', runOptions.filename] : []),
  ]);
  const downloadResult = await executeGatewayRequest(
    downloadPayload.httpRequest,
    options,
  );
  const evidence = freshnessEvidence({
    commandPoll,
    camera,
    thumbnailPath,
    downloadResult,
    previousSha256: runOptions.previousSha256,
    previousThumbnailPath,
  });
  const display = thumbnailRefreshDisplay(evidence, downloadResult);
  return {
    command: 'live',
    operation: 'camera-thumbnail-refresh',
    stakesTier: OPERATION_TIERS['camera-thumbnail-refresh'],
    request: {
      beforeDevices: liveRequestSummary(beforeDevicesPayload.httpRequest),
      trigger: liveRequestSummary(mutationPayload.httpRequest),
      commandStatus: command
        ? liveRequestSummary(
            buildCommandStatusRequest(
              'camera-thumbnail-refresh',
              command.network || runOptions.network,
              command.id,
            ),
          )
        : undefined,
      devices: liveRequestSummary(devicesPayload.httpRequest),
      thumbnail: liveRequestSummary(downloadPayload.httpRequest),
    },
    result: {
      ok: evidence.ok,
      trigger: triggerResult.bodyJson || {
        status: triggerResult.status,
        statusText: triggerResult.statusText,
      },
      commandPoll,
      camera: cameraSummary(camera),
      freshness: evidence,
      display,
    },
    artifact: {
      mode: evidence.ok ? 'gateway-artifact' : 'withheld-stale-thumbnail',
      maxInlineBytes: 0,
      handling:
        evidence.ok
          ? 'Return and display the artifact handle because freshness.ok is true.'
          : 'Do not return or display the stale artifact handle because freshness.ok is false.',
    },
    costMeasurement: COST_MEASUREMENT,
  };
}

async function runLive(argv, options = {}) {
  const args = [...argv];
  const format = popFlag(args, '--format', 'pretty');
  if (!['json', 'pretty'].includes(format))
    die('--format must be json or pretty.');
  configureUserAgent(args);
  const command = args.shift();
  if (command !== 'run') {
    die(`Unsupported Blink live command: ${command || '(missing)'}`);
  }
  const operation = canonicalOperation(args.shift());
  if (operation === 'account-login') {
    return runAccountLogin(args, options);
  }
  if (operation === 'account-refresh') {
    return runAccountRefresh(args, options);
  }
  if (operation === 'camera-thumbnail-refresh') {
    return runCameraThumbnailRefresh(args, options);
  }
  if (!HTTP_OPERATIONS.has(operation) && !PLAN_OPERATIONS.has(operation)) {
    die(`Unsupported Blink run operation: ${operation || '(missing)'}`);
  }
  const payload =
    PLAN_OPERATIONS.has(operation)
      ? buildMutationRequest(operation, args, { requireGrant: true }).payload
      : buildReadOperation(operation, args);
  if (!payload.httpRequest) {
    die(`Blink operation ${operation} cannot be run live.`);
  }
  return executeLivePayload(payload, options);
}

function buildRequest(argv) {
  const args = [...argv];
  const format = popFlag(args, '--format', 'pretty');
  if (!['json', 'pretty'].includes(format))
    die('--format must be json or pretty.');
  configureUserAgent(args);
  const command = args.shift();
  const operation = canonicalOperation(args.shift());
  if (command === 'http-request') {
    if (HTTP_OPERATIONS.has(operation))
      return buildReadOperation(operation, args);
    if (PLAN_OPERATIONS.has(operation)) {
      const { payload } = buildMutationRequest(operation, args, {
        requireGrant: true,
      });
      return payload;
    }
    die(
      `Unsupported Blink http-request operation: ${operation || '(missing)'}`,
    );
  }
  if (command === 'plan') return buildPlan(operation, args);
  die(`Unsupported Blink command: ${command || '(missing)'}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const format = args.includes('--format')
    ? args[args.indexOf('--format') + 1]
    : 'pretty';
  const emitArgs = [...args];
  popFlag(emitArgs, '--format', 'pretty');
  const command = emitArgs[0];
  const payload =
    command === 'run' ? await runLive(args) : buildRequest(args);
  process.stdout.write(
    JSON.stringify(payload, null, format === 'pretty' ? 2 : 0),
  );
  process.stdout.write('\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  buildRequest,
  executeGatewayRequest,
  executeLivePayload,
  extractAuthorizationCode,
  extractCsrfToken,
  generatePkcePair,
  runAccountLogin,
  runLive,
  SECRET_NAMES,
};
