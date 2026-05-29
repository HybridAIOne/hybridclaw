#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const os = require('node:os');

const DEFAULT_TIMEOUT_MS = 15_000;
const SKILL_NAME = 'blink';
const REST_PROD_HOST = 'rest-prod.immedia-semi.com';
const PROD_HOST = 'prod.immedia-semi.com';
const DEFAULT_REST_BASE = `https://${REST_PROD_HOST}`;
const DEFAULT_BLINK_APP_VERSION = '55.2';
const DEFAULT_USER_AGENT = `BlinkHomeSecurity/${DEFAULT_BLINK_APP_VERSION} (iPhone; iOS 17.6; Scale/3.00)`;
let userAgent = DEFAULT_USER_AGENT;
const COST_MEASUREMENT = {
  system: 'UsageTotals',
  subLimitKey: 'blink',
};

const SECRET_NAMES = {
  email: 'BLINK_EMAIL',
  password: 'BLINK_PASSWORD',
  authToken: 'BLINK_AUTH_TOKEN',
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
  node skills/blink/blink.cjs [--format json|pretty] http-request <operation> [flags]
  node skills/blink/blink.cjs [--format json|pretty] plan <operation> [flags]

Read/request commands:
  http-request account-login
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
  http-request clips-list [--since 2026-05-26T00:00:00Z] [--page 0] [--max 50]
  http-request clip-download --path /api/v2/accounts/<account-id>/media/clip/<file.mp4>

Guarded operation plans:
  plan network-arm --network <network-id>
  plan network-disarm --network <network-id>
  plan camera-motion-set --network <network-id> --camera <camera-id> --enable true
  plan camera-thumbnail-refresh --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell]
  plan clip-watched-mark --clip <clip-id>
  plan clip-delete --clip <clip-id>
  plan camera-live-view-start --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell]

Environment:
  BLINK_DEVICE_ID     reserved for future OAuth v2 login support
  BLINK_CLIENT_NAME   reserved for future OAuth v2 login support
  BLINK_USER_AGENT    reserved for future OAuth v2 login support
  BLINK_TIER          optional resolved tier, for example e003
  BLINK_ACCOUNT_ID    optional numeric account id fallback
  BLINK_CLIENT_ID     optional numeric client id fallback

Notes:
  Operation names use subject-verb form. Legacy aliases such as login, homescreen,
  cameras, and clips are accepted but canonical output uses account-login,
  devices-list, cameras-list, and clips-list.
  clips-list is account-scoped on Blink's media/changed API; --network is rejected.
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
      name: 'TOKEN_AUTH',
      secretName: SECRET_NAMES.authToken,
      prefix: 'none',
    },
  ];
}

function buildPayload(
  operation,
  {
    url,
    method = 'GET',
    headers,
    json,
    maxResponseBytes,
    captureResponseFields,
    suppressResponseBody,
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
  if (json !== undefined) payload.httpRequest.json = json;
  if (captureResponseFields !== undefined) {
    payload.httpRequest.captureResponseFields = captureResponseFields;
  }
  if (suppressResponseBody === true) {
    payload.httpRequest.suppressResponseBody = true;
  }
  if (artifact !== undefined) payload.artifact = artifact;
  if (handover !== undefined) payload.handover = handover;
  if (responseHandling !== undefined)
    payload.responseHandling = responseHandling;
  return payload;
}

function buildAccountLogin(args) {
  assertNoUnexpectedArgs(args);
  return {
    command: 'auth-required',
    operation: 'account-login',
    stakesTier: OPERATION_TIERS['account-login'],
    hardStop: true,
    reason: 'blink-oauth-v2-required',
    result:
      'Blink password login is no longer emitted because the legacy /api/v5/account/login endpoint returns 426 app-update responses and the OAuth password grant returns unsupported_grant_type. Existing stored tokens may still work for read operations; otherwise the Blink skill needs a cookie-safe OAuth v2 Authorization Code + PKCE implementation before it can log in.',
    unsupportedRequests: [
      'POST https://rest-prod.immedia-semi.com/api/v5/account/login',
      'POST https://api.oauth.blink.com/oauth/token grant_type=password',
    ],
    requiredFlow: {
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
      'Stop. Do not call http_request for legacy Blink login, do not try alternate /api/v3-/api/v6 login paths, do not try OAuth grant_type=password, and do not web-search inside the user task. Report that OAuth v2 support is required unless existing BLINK_AUTH_TOKEN/BLINK_TIER/BLINK_ACCOUNT_ID secrets are already set.',
    costMeasurement: COST_MEASUREMENT,
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
    };
  } else if (operation === 'clip-download') {
    const clipPath = parseClipPath(popFlag(args, '--path'), accountId);
    url = `${prodBase()}{PATH}`.replace('{PATH}', clipPath);
    artifact = {
      mode: 'gateway-artifact',
      maxInlineBytes: 0,
      handling:
        'Return an artifact handle only; do not include raw video bytes in model context.',
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
    maxResponseBytes: operation === 'clip-download' ? 50_000_000 : 2_000_000,
    suppressResponseBody: operation === 'clip-download',
    artifact,
  });
}

function prodBase() {
  return `https://${PROD_HOST}`;
}

function parseHttpRequestTarget(rawUrl) {
  const match = String(rawUrl).match(/^https:\/\/([^/]+)(\/[^?#]*)/u);
  if (!match) die(`Invalid helper-emitted URL: ${rawUrl}`);
  return {
    host: match[1],
    path: match[2],
  };
}

function parseClipPath(value, accountId) {
  const normalized = requireText(value, '--path');
  const accountPrefix = `/api/v2/accounts/${accountId}/media/`;
  const accountPattern = accountId.startsWith('<secret:')
    ? '<secret:BLINK_ACCOUNT_ID>'
    : accountId;
  const pathPattern = new RegExp(
    `^/api/v2/accounts/${accountPattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/media/(clip|thumb)/[A-Za-z0-9_.%/-]+$`,
    'u',
  );
  if (
    !normalized.startsWith(accountPrefix) ||
    normalized.includes('..') ||
    !pathPattern.test(normalized)
  ) {
    die(
      `--path must be a Blink media path under ${accountPrefix}clip/ or ${accountPrefix}thumb/.`,
    );
  }
  return normalized;
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
    'http-request',
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

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const format = args.includes('--format')
    ? args[args.indexOf('--format') + 1]
    : 'pretty';
  try {
    const payload = buildRequest(args);
    process.stdout.write(
      JSON.stringify(payload, null, format === 'pretty' ? 2 : 0),
    );
    process.stdout.write('\n');
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  buildRequest,
  SECRET_NAMES,
};
