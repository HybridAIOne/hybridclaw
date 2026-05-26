#!/usr/bin/env node
'use strict';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const GATEWAY_TIMEOUT_BUFFER_MS = 1_000;
const CLOUD_AUTH_SECRET = 'SHELLY_CLOUD_AUTH_KEY';
const CLOUD_ACCESS_TOKEN_SECRET = 'SHELLY_CLOUD_ACCESS_TOKEN';
const CLOUD_OAUTH_CODE_SECRET = 'SHELLY_OAUTH_CODE';
const COST_MEASUREMENT = {
  system: 'UsageTotals',
  subLimitKey: 'shelly',
};

const OPERATION_TIERS = {
  'local-gen1-shelly': 'green',
  'local-gen1-status': 'green',
  'local-gen1-get': 'green',
  'local-gen1-set': 'amber',
  'local-gen1-relay-status': 'green',
  'local-gen1-relay-set': 'amber',
  'local-gen2-rpc-get': 'green',
  'local-gen2-rpc-call': 'amber',
  'local-gen2-info': 'green',
  'local-gen2-status': 'green',
  'local-gen2-config': 'green',
  'local-gen2-methods': 'green',
  'local-gen2-components': 'green',
  'local-gen2-cover-config': 'green',
  'local-gen2-cover-status': 'green',
  'local-gen2-cover-open': 'amber',
  'local-gen2-cover-close': 'amber',
  'local-gen2-cover-stop': 'amber',
  'local-gen2-cover-goto-position': 'amber',
  'local-gen2-switch-status': 'green',
  'local-gen2-switch-set': 'amber',
  'local-gen2-switch-toggle': 'amber',
  'cloud-get-state': 'green',
  'cloud-oauth-token': 'green',
  'cloud-all-status': 'green',
  'cloud-websocket-url': 'green',
  'cloud-websocket-command': 'amber',
  'cloud-set-switch': 'amber',
  'cloud-set-light': 'amber',
  'cloud-set-cover': 'amber',
};

const DOMAIN_COMMANDS = new Set([
  'device',
  'gen1',
  'rpc',
  'cover',
  'switch',
  'relay',
  'light',
  'cloud',
]);

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function printHelp() {
  console.log(`Shelly skill helper

Usage:
  node skills/shelly/shelly.cjs [--format json|pretty] [--request] <resource> <action> [flags]
  node skills/shelly/shelly.cjs [--format json|pretty] approval-plan <resource> <action> [flags]

Commands:
  device info --device-url http://192.0.2.10 [--ident]
  device status --device-url http://192.0.2.10
  device config --device-url http://192.0.2.10
  device methods --device-url http://192.0.2.10
  device components --device-url http://192.0.2.10 [--include status] [--include config] [--key switch:0]
  cover config --device-url http://192.0.2.10 --id 0
  cover status --device-url http://192.0.2.10 --id 0
  cover open --device-url http://192.0.2.10 --id 0 --operator-grant
  cover close --device-url http://192.0.2.10 --id 0 --operator-grant
  cover stop --device-url http://192.0.2.10 --id 0 --operator-grant
  cover goto --device-url http://192.0.2.10 --id 0 --position 50 --operator-grant
  cover status --cloud-host https://<HOST> --device-id abc123
  cover goto --cloud-host https://<HOST> --device-id abc123 --position 50 --operator-grant
  switch status --device-url http://192.0.2.10 --id 0
  switch set --device-url http://192.0.2.10 --id 0 --on true --operator-grant
  switch toggle --device-url http://192.0.2.10 --id 0 --operator-grant
  switch set --cloud-host https://<HOST> --device-id abc123 --on true --operator-grant
  relay status --device-url http://192.0.2.10 --id 0
  relay set --device-url http://192.0.2.10 --id 0 --turn on|off|toggle --operator-grant
  light set --cloud-host https://<HOST> --device-id abc123 --on true --brightness 50 --operator-grant
  cloud state --cloud-host https://<HOST> --device-id abc123 --select status
  cloud all-status --cloud-host https://<HOST>
  cloud oauth-token --cloud-host https://<HOST>
  cloud websocket-url --cloud-host https://<HOST>
  cloud websocket-command --cloud-host https://<HOST> --device-id abc123 --cmd roller_to_pos --params-json '{"id":0,"pos":50}' --operator-grant
  gen1 get --device-url http://192.0.2.10 --path /settings [--query key=value]
  gen1 set --device-url http://192.0.2.10 --path /settings/relay/0 --query default_state=on --operator-grant
  rpc get --device-url http://192.0.2.10 --method Cloud.GetStatus [--param id=0] [--params-json '{}']
  rpc call --device-url http://192.0.2.10 --method Cover.Calibrate --params-json '{"id":0}' --operator-grant

Environment:
  HYBRIDCLAW_GATEWAY_URL   gateway base URL for live execution (default: http://127.0.0.1:9090)
  HYBRIDCLAW_GATEWAY_TOKEN gateway bearer token for live execution
  SHELLY_DEVICE_URL        default local device base URL
  SHELLY_CLOUD_HOST        default Shelly Cloud tenant server URI
  SHELLY_CLOUD_AUTH_KEY    stored HybridClaw secret name used through <secret:SHELLY_CLOUD_AUTH_KEY>
  SHELLY_CLOUD_ACCESS_TOKEN stored OAuth/Bearer token for Real Time Events HTTP API
  SHELLY_OAUTH_CODE        temporary authorization code secret for cloud oauth-token
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

function popBoolean(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function popRepeatedFlag(args, name) {
  const values = [];
  for (;;) {
    const index = args.indexOf(name);
    if (index === -1) return values;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      die(`${name} requires a value.`);
    }
    values.push(value);
    args.splice(index, 2);
  }
}

function assertNoUnexpectedArgs(args) {
  if (args.length > 0) {
    die(`Unexpected argument: ${args[0]}`);
  }
}

function hasFlag(args, name) {
  return args.includes(name);
}

function hasAnyFlag(args, names) {
  return names.some((name) => hasFlag(args, name));
}

function addDefaultRepeatedFlag(args, name, values) {
  if (hasFlag(args, name)) return args;
  return [...args, ...values.flatMap((value) => [name, value])];
}

function normalizeFlagAliases(args) {
  return args.map((arg) => {
    if (arg === '--device') return '--device-url';
    return arg;
  });
}

function requireText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function parseInteger(value, label) {
  const raw = requireText(value, label);
  if (!/^-?\d+$/.test(raw)) die(`${label} must be an integer.`);
  return Number(raw);
}

function parseNonNegativeInteger(value, label) {
  const parsed = parseInteger(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    die(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function parseNumber(value, label) {
  const raw = requireText(value, label);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) die(`${label} must be a number.`);
  return parsed;
}

function parseBooleanValue(value, label) {
  const normalized = requireText(value, label).toLowerCase();
  if (['true', 'on', '1', 'yes'].includes(normalized)) return true;
  if (['false', 'off', '0', 'no'].includes(normalized)) return false;
  die(`${label} must be true or false.`);
}

function parseJsonObject(value, label) {
  const raw = requireText(value, label);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    die(`${label} must be valid JSON: ${error.message}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    die(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseParamValue(raw) {
  const value = String(raw);
  if (/^(true|false|null)$/u.test(value)) return JSON.parse(value);
  if (/^-?\d+(\.\d+)?$/u.test(value)) return Number(value);
  if (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function parseKeyValuePairs(args, flag) {
  const pairs = popRepeatedFlag(args, flag);
  const parsed = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index < 1) die(`${flag} must use key=value.`);
    const key = pair.slice(0, index).trim();
    if (!key) die(`${flag} key is required.`);
    parsed[key] = parseParamValue(pair.slice(index + 1));
  }
  return parsed;
}

function mergeParams(args) {
  const params = parseKeyValuePairs(args, '--param');
  const json = popFlag(args, '--params-json');
  if (json !== undefined)
    Object.assign(params, parseJsonObject(json, '--params-json'));
  return params;
}

function parsePath(value, label) {
  const path = requireText(value, label);
  if (!path.startsWith('/')) die(`${label} must start with "/".`);
  if (path.includes('..')) die(`${label} must not contain "..".`);
  if (path.includes('?'))
    die(`${label} must not include a query string; use --query.`);
  if (/\/{2,}/u.test(path)) die(`${label} must not contain duplicate slashes.`);
  return path;
}

function parseRpcMethod(value, label = '--method') {
  const method = requireText(value, label);
  if (!/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/u.test(method)) {
    die(`${label} must look like Namespace.Method.`);
  }
  return method;
}

function rpcAction(method) {
  return method.split('.')[1] || '';
}

function assertReadRpcMethod(method) {
  if (!/^(Get|List|Check)/u.test(rpcAction(method))) {
    die(
      'rpc get only allows read methods; use rpc call for state-changing methods.',
    );
  }
}

function assertAllowedRpcCall(method) {
  if (
    /^(FactoryReset|ResetWiFiConfig|Reboot|Update|SetAuth|PutTLS|PutUserCA)/u.test(
      rpcAction(method),
    )
  ) {
    die(`${method} is not allowed through this skill.`);
  }
}

function assertAllowedGen1Path(path) {
  if (
    /\/(reboot|ota|sta_cache_reset|poweroff|calibrate|reset_data)(\/|$)/u.test(
      path,
    ) ||
    path === '/settings/login'
  ) {
    die(`${path} is not allowed through this skill.`);
  }
}

function parseOptionalTag(args) {
  const tag = popFlag(args, '--tag');
  if (tag === undefined) return undefined;
  const normalized = String(tag).trim();
  if (normalized.length > 20) die('--tag must be at most 20 characters.');
  return normalized || null;
}

function requireGrant(args, operation) {
  if (OPERATION_TIERS[operation] === 'green') return;
  if (!popBoolean(args, '--operator-grant')) {
    die(
      `${operation} is ${OPERATION_TIERS[operation]}; pass --operator-grant only after explicit operator approval.`,
    );
  }
}

function normalizeBaseUrl(
  raw,
  label,
  { defaultProtocol, requireHttps = false },
) {
  let value = requireText(raw, label);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `${defaultProtocol}://${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    die(`${label} must be an absolute http or https URL.`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    die(`${label} must use http or https.`);
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    die(`${label} must use https for Shelly Cloud requests.`);
  }
  if (parsed.username || parsed.password) {
    die(`${label} must not embed credentials.`);
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed;
}

function resolveDeviceBase(args) {
  const value = popFlag(args, '--device-url') || process.env.SHELLY_DEVICE_URL;
  return normalizeBaseUrl(value, '--device-url', { defaultProtocol: 'http' });
}

function resolveCloudBase(args) {
  const value = popFlag(args, '--cloud-host') || process.env.SHELLY_CLOUD_HOST;
  return normalizeBaseUrl(value, '--cloud-host', {
    defaultProtocol: 'https',
    requireHttps: true,
  });
}

function appendPath(base, path) {
  const next = new URL(base.toString());
  next.pathname = `${base.pathname}${path}`.replace(/\/{2,}/gu, '/');
  return next;
}

function appendQuery(url, params) {
  const next = new URL(url.toString());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      next.searchParams.set(key, String(value));
    }
  }
  return next.toString();
}

function appendQueryPairs(url, params) {
  const next = new URL(url.toString());
  for (const [key, value] of Object.entries(params)) {
    next.searchParams.set(key, String(value));
  }
  return next.toString();
}

function rpcGetUrl(base, method, params = {}) {
  return appendQuery(appendPath(base, `/rpc/${method}`), params);
}

function buildPayload(
  operation,
  {
    url,
    method = 'GET',
    headers,
    body,
    json,
    maxResponseBytes,
    secretHeaders,
    replaceSecretPlaceholders,
    captureResponseFields,
    requiresConfiguredSecrets,
    capturesSecrets,
    rpcMethod,
  },
) {
  const tier = OPERATION_TIERS[operation];
  const payload = {
    command: 'http-request',
    operation,
    stakesTier: tier,
    httpRequest: {
      url,
      method,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: maxResponseBytes || 1_000_000,
      skillName: 'shelly',
      stakesTier: tier,
    },
    costMeasurement: COST_MEASUREMENT,
  };
  if (headers !== undefined) payload.httpRequest.headers = headers;
  if (body !== undefined) payload.httpRequest.body = body;
  if (json !== undefined) payload.httpRequest.json = json;
  if (secretHeaders !== undefined) {
    payload.httpRequest.secretHeaders = secretHeaders;
  }
  if (replaceSecretPlaceholders !== undefined) {
    payload.httpRequest.replaceSecretPlaceholders = replaceSecretPlaceholders;
  }
  if (captureResponseFields !== undefined) {
    payload.httpRequest.captureResponseFields = captureResponseFields;
  }
  if (rpcMethod !== undefined) {
    payload.rpcMethod = rpcMethod;
  }
  if (operation === 'cloud-oauth-token') {
    payload.secretRefPolicy =
      'The OAuth authorization code is emitted as a secret placeholder and the access_token is captured into SHELLY_CLOUD_ACCESS_TOKEN; never paste the real code or token into chat or helper arguments.';
    payload.liveExecution = {
      mode: 'live-shelly-real-time-events-oauth-token-exchange',
      requiresConfiguredSecrets: requiresConfiguredSecrets || [
        CLOUD_OAUTH_CODE_SECRET,
      ],
      capturesSecrets: capturesSecrets || [CLOUD_ACCESS_TOKEN_SECRET],
    };
  } else if (operation === 'cloud-all-status') {
    payload.secretRefPolicy =
      'The Authorization header is emitted as a secretHeaders reference to SHELLY_CLOUD_ACCESS_TOKEN; never paste the real Shelly OAuth access token into chat or helper arguments.';
    payload.liveExecution = {
      mode: 'live-shelly-real-time-events-http-api',
      requiresConfiguredSecrets: [CLOUD_ACCESS_TOKEN_SECRET],
      rateLimit:
        'Shelly Cloud Real Time Events HTTP API requests are account-level reads; keep polling conservative.',
    };
  } else if (operation.startsWith('cloud-')) {
    payload.secretRefPolicy =
      'The auth_key is emitted as <secret:SHELLY_CLOUD_AUTH_KEY>; never paste the real Shelly cloud authorization key into chat or helper arguments.';
    payload.liveExecution = {
      mode: 'live-shelly-cloud-control-api',
      requiresConfiguredSecrets: [CLOUD_AUTH_SECRET],
      rateLimit:
        'Shelly Cloud Control API requests are limited to 1 request/second.',
    };
  }
  return payload;
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
    bodyJson: parseJsonMaybe(body),
    bodyTruncated: wrapper.bodyTruncated === true,
    maxResponseBytes: wrapper.maxResponseBytes,
  };
}

function gatewayErrorMessage(response, text) {
  const parsed = parseJsonMaybe(text);
  const errorText =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? String(parsed.error || parsed.text || text).trim()
      : String(text || '').trim();
  const prefix = `Gateway proxy returned HTTP ${response.status} for Shelly request`;
  if (
    response.status === 400 &&
    /not allowlisted by workspace network policy/u.test(errorText)
  ) {
    return `${prefix}: workspace network policy denied this helper-emitted target. ${errorText}`;
  }
  if (
    response.status === 502 &&
    /Outbound HTTP request failed/u.test(errorText)
  ) {
    return `${prefix}: gateway policy accepted the request, but the gateway process could not open the outbound connection. ${errorText}`;
  }
  return `${prefix}: ${errorText || text}`;
}

function formatErrorCause(error) {
  if (!error || typeof error !== 'object') return '';
  const cause = error.cause;
  if (!cause) return '';
  if (cause instanceof Error) {
    const nested = formatErrorCause(cause);
    return nested && !cause.message.includes(nested)
      ? `${cause.message} (${nested})`
      : cause.message;
  }
  if (typeof cause === 'object') {
    const code = typeof cause.code === 'string' ? cause.code : '';
    const message = typeof cause.message === 'string' ? cause.message : '';
    return [code, message].filter(Boolean).join(' ');
  }
  return String(cause);
}

function formatTransportError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = formatErrorCause(error);
  if (!cause || error.message.includes(cause)) return error.message;
  return `${error.message} (${cause})`;
}

async function executeGatewayRequest(httpRequest, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for Shelly requests.');
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
        `Gateway proxy request failed before Shelly request was sent: ${formatTransportError(
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
      `Shelly response was truncated by the gateway at ${normalized.maxResponseBytes || 'the configured'} bytes.`,
    );
  }
  if (!normalized.ok) {
    throw new Error(
      `Shelly returned HTTP ${normalized.status || 'error'}: ${
        normalized.body || normalized.statusText
      }`,
    );
  }
  return normalized;
}

function buildWebSocketPayload(operation, { urlTemplate, message }) {
  const payload = {
    command: 'websocket',
    operation,
    stakesTier: OPERATION_TIERS[operation],
    webSocket: {
      urlTemplate,
      replaceSecretPlaceholders: true,
      skillName: 'shelly',
      stakesTier: OPERATION_TIERS[operation],
    },
    secretRefPolicy:
      'The WebSocket URL template contains a secret placeholder for SHELLY_CLOUD_ACCESS_TOKEN; never paste the real token into chat or helper arguments.',
    liveExecution: {
      mode: 'live-shelly-real-time-events-websocket',
      requiresConfiguredSecrets: [CLOUD_ACCESS_TOKEN_SECRET],
    },
    costMeasurement: COST_MEASUREMENT,
  };
  if (message !== undefined) payload.webSocket.message = message;
  return payload;
}

function buildRpcPost(operation, base, method, params) {
  return buildPayload(operation, {
    url: appendPath(base, `/rpc/${method}`).toString(),
    method: 'POST',
    json: params,
    rpcMethod: method,
  });
}

function buildGenericRpcGet(args) {
  const base = resolveDeviceBase(args);
  const method = parseRpcMethod(popFlag(args, '--method'));
  assertReadRpcMethod(method);
  const params = mergeParams(args);
  assertNoUnexpectedArgs(args);
  return buildPayload('local-gen2-rpc-get', {
    url: rpcGetUrl(base, method, params),
  });
}

function buildGenericRpcCall(args) {
  const base = resolveDeviceBase(args);
  const method = parseRpcMethod(popFlag(args, '--method'));
  assertAllowedRpcCall(method);
  const params = mergeParams(args);
  requireGrant(args, 'local-gen2-rpc-call');
  assertNoUnexpectedArgs(args);
  return buildRpcPost('local-gen2-rpc-call', base, method, params);
}

function buildLocalGen2(operation, args) {
  const base = resolveDeviceBase(args);

  if (operation === 'local-gen2-info') {
    const params = popBoolean(args, '--ident') ? { ident: true } : {};
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Shelly.GetDeviceInfo', params),
    });
  }

  if (operation === 'local-gen2-status') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Shelly.GetStatus'),
    });
  }

  if (operation === 'local-gen2-config') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Shelly.GetConfig'),
    });
  }

  if (operation === 'local-gen2-methods') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Shelly.ListMethods'),
    });
  }

  if (operation === 'local-gen2-components') {
    const params = {};
    const include = popRepeatedFlag(args, '--include');
    if (include.length > 0) {
      const allowed = new Set(['status', 'config']);
      for (const value of include) {
        if (!allowed.has(value)) die('--include must be status or config.');
      }
      params.include = include;
    }
    const keys = popRepeatedFlag(args, '--key');
    if (keys.length > 0) params.keys = keys;
    if (popBoolean(args, '--dynamic-only')) params.dynamic_only = true;
    const offset = popFlag(args, '--offset');
    if (offset !== undefined)
      params.offset = parseNonNegativeInteger(offset, '--offset');
    assertNoUnexpectedArgs(args);
    return buildRpcPost(operation, base, 'Shelly.GetComponents', params);
  }

  if (operation === 'local-gen2-cover-config') {
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Cover.GetConfig', { id }),
    });
  }

  if (operation === 'local-gen2-cover-status') {
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Cover.GetStatus', { id }),
    });
  }

  if (
    operation === 'local-gen2-cover-open' ||
    operation === 'local-gen2-cover-close'
  ) {
    requireGrant(args, operation);
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    const params = { id };
    const duration = popFlag(args, '--duration');
    if (duration !== undefined) {
      params.duration = parsePositiveNumber(duration, '--duration');
    }
    const tag = parseOptionalTag(args);
    if (tag !== undefined) params.tag = tag;
    assertNoUnexpectedArgs(args);
    return buildRpcPost(
      operation,
      base,
      operation === 'local-gen2-cover-open' ? 'Cover.Open' : 'Cover.Close',
      params,
    );
  }

  if (operation === 'local-gen2-cover-stop') {
    requireGrant(args, operation);
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    const params = { id };
    const tag = parseOptionalTag(args);
    if (tag !== undefined) params.tag = tag;
    assertNoUnexpectedArgs(args);
    return buildRpcPost(operation, base, 'Cover.Stop', params);
  }

  if (operation === 'local-gen2-cover-goto-position') {
    requireGrant(args, operation);
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    const params = { id };
    const position = popFlag(args, '--position');
    const relative = popFlag(args, '--relative');
    const slatPosition = popFlag(args, '--slat-position');
    const slatRelative = popFlag(args, '--slat-relative');
    if (position !== undefined && relative !== undefined) {
      die('--position and --relative cannot be used together.');
    }
    if (slatPosition !== undefined && slatRelative !== undefined) {
      die('--slat-position and --slat-relative cannot be used together.');
    }
    if (position !== undefined) {
      params.pos = parseBoundedNumber(position, '--position', 0, 100);
    }
    if (relative !== undefined) {
      params.rel = parseBoundedNumber(relative, '--relative', -100, 100);
    }
    if (slatPosition !== undefined) {
      params.slat_pos = parseBoundedNumber(
        slatPosition,
        '--slat-position',
        0,
        100,
      );
    }
    if (slatRelative !== undefined) {
      params.slat_rel = parseBoundedNumber(
        slatRelative,
        '--slat-relative',
        -100,
        100,
      );
    }
    if (
      params.pos === undefined &&
      params.rel === undefined &&
      params.slat_pos === undefined &&
      params.slat_rel === undefined
    ) {
      die(
        'local-gen2-cover-goto-position requires --position, --relative, --slat-position, or --slat-relative.',
      );
    }
    const tag = parseOptionalTag(args);
    if (tag !== undefined) params.tag = tag;
    assertNoUnexpectedArgs(args);
    return buildRpcPost(operation, base, 'Cover.GoToPosition', params);
  }

  if (operation === 'local-gen2-switch-status') {
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Switch.GetStatus', { id }),
    });
  }

  if (operation === 'local-gen2-switch-set') {
    requireGrant(args, operation);
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    const on = parseBooleanValue(popFlag(args, '--on'), '--on');
    const params = { id, on };
    const toggleAfter = popFlag(args, '--toggle-after');
    if (toggleAfter !== undefined) {
      const parsed = parseNumber(toggleAfter, '--toggle-after');
      if (parsed <= 0) die('--toggle-after must be greater than 0.');
      params.toggle_after = parsed;
    }
    assertNoUnexpectedArgs(args);
    return buildRpcPost(operation, base, 'Switch.Set', params);
  }

  if (operation === 'local-gen2-switch-toggle') {
    requireGrant(args, operation);
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    assertNoUnexpectedArgs(args);
    return buildRpcPost(operation, base, 'Switch.Toggle', { id });
  }

  die(`Unsupported local Gen2 operation: ${operation}`);
}

function buildLocalGen1(operation, args) {
  const base = resolveDeviceBase(args);

  if (operation === 'local-gen1-shelly') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendPath(base, '/shelly').toString(),
    });
  }

  if (operation === 'local-gen1-status') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendPath(base, '/status').toString(),
    });
  }

  if (operation === 'local-gen1-get') {
    const path = parsePath(popFlag(args, '--path'), '--path');
    assertAllowedGen1Path(path);
    const query = parseKeyValuePairs(args, '--query');
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendQueryPairs(appendPath(base, path), query),
    });
  }

  if (operation === 'local-gen1-set') {
    requireGrant(args, operation);
    const path = parsePath(popFlag(args, '--path'), '--path');
    assertAllowedGen1Path(path);
    const query = parseKeyValuePairs(args, '--query');
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendQueryPairs(appendPath(base, path), query),
    });
  }

  if (operation === 'local-gen1-relay-status') {
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendPath(base, `/relay/${id}`).toString(),
    });
  }

  if (operation === 'local-gen1-relay-set') {
    requireGrant(args, operation);
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    const turn = requireText(popFlag(args, '--turn'), '--turn').toLowerCase();
    if (!['on', 'off', 'toggle'].includes(turn)) {
      die('--turn must be on, off, or toggle.');
    }
    const params = { turn };
    const timer = popFlag(args, '--timer');
    if (timer !== undefined) {
      const parsed = parseNumber(timer, '--timer');
      if (parsed <= 0) die('--timer must be greater than 0.');
      params.timer = parsed;
    }
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendQuery(appendPath(base, `/relay/${id}`), params),
    });
  }

  die(`Unsupported local Gen1 operation: ${operation}`);
}

function cloudUrl(base, path) {
  return `${appendPath(base, path).toString()}?auth_key=<secret:${CLOUD_AUTH_SECRET}>`;
}

function realTimeEventsUrl(base, path, params = {}) {
  return appendQuery(appendPath(base, path), params);
}

function parseSecretName(value, label) {
  const secretName = requireText(value, label);
  if (!/^[A-Z][A-Z0-9_]*$/u.test(secretName)) {
    die(`${label} must be an uppercase runtime secret name.`);
  }
  return secretName;
}

function parseDeviceId(args) {
  return requireText(
    popFlag(args, '--device-id') || popFlag(args, '--id'),
    '--device-id',
  );
}

function buildCloud(operation, args) {
  const base = resolveCloudBase(args);

  if (operation === 'cloud-get-state') {
    const ids = popRepeatedFlag(args, '--device-id');
    const aliasId = popFlag(args, '--id');
    if (aliasId) ids.push(aliasId);
    if (ids.length < 1 || ids.length > 10) {
      die('cloud-get-state requires between 1 and 10 --device-id values.');
    }
    const select = popRepeatedFlag(args, '--select');
    const pickStatus = popRepeatedFlag(args, '--pick-status');
    const pickSettings = popRepeatedFlag(args, '--pick-settings');
    const json = { ids };
    if (select.length > 0) {
      const allowed = new Set(['status', 'settings']);
      for (const value of select) {
        if (!allowed.has(value)) die('--select must be status or settings.');
      }
      json.select = select;
    }
    const pick = {};
    if (pickStatus.length > 0) pick.status = pickStatus;
    if (pickSettings.length > 0) pick.settings = pickSettings;
    if (Object.keys(pick).length > 0) json.pick = pick;
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: cloudUrl(base, '/v2/devices/api/get'),
      method: 'POST',
      json,
      maxResponseBytes: 2_000_000,
    });
  }

  if (operation === 'cloud-oauth-token') {
    const clientId = requireText(
      popFlag(args, '--client-id', 'shelly-diy'),
      '--client-id',
    );
    const codeSecret = parseSecretName(
      popFlag(args, '--code-secret', CLOUD_OAUTH_CODE_SECRET),
      '--code-secret',
    );
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendPath(base, '/oauth/auth').toString(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `client_id=${encodeURIComponent(clientId)}&grant_type=code&code=<secret:${codeSecret}>`,
      replaceSecretPlaceholders: true,
      captureResponseFields: [
        {
          jsonPath: 'access_token',
          secretName: CLOUD_ACCESS_TOKEN_SECRET,
        },
      ],
      requiresConfiguredSecrets: [codeSecret],
      capturesSecrets: [CLOUD_ACCESS_TOKEN_SECRET],
      maxResponseBytes: 200_000,
    });
  }

  if (operation === 'cloud-all-status') {
    const includeShared = popBoolean(args, '--include-shared');
    const showInfo = !popBoolean(args, '--without-info');
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: realTimeEventsUrl(base, '/device/all_status', {
        show_info: showInfo,
        no_shared: !includeShared,
      }),
      method: 'GET',
      maxResponseBytes: 5_000_000,
      secretHeaders: [
        {
          name: 'Authorization',
          secretName: CLOUD_ACCESS_TOKEN_SECRET,
          prefix: 'Bearer',
        },
      ],
      json: undefined,
    });
  }

  if (operation === 'cloud-websocket-url') {
    assertNoUnexpectedArgs(args);
    return buildWebSocketPayload(operation, {
      urlTemplate: `wss://${base.hostname}:6113/shelly/wss/hk_sock?t=<secret:${CLOUD_ACCESS_TOKEN_SECRET}>`,
    });
  }

  if (operation === 'cloud-websocket-command') {
    requireGrant(args, operation);
    const deviceId = parseDeviceId(args);
    const trid = parseNonNegativeInteger(
      popFlag(args, '--trid', '1'),
      '--trid',
    );
    const cmd = requireText(popFlag(args, '--cmd'), '--cmd');
    const allowedCommands = new Set([
      'relay',
      'light',
      'roller',
      'roller_to_pos',
    ]);
    if (!allowedCommands.has(cmd)) {
      die('--cmd must be relay, light, roller, or roller_to_pos.');
    }
    const params = parseJsonObject(
      popFlag(args, '--params-json'),
      '--params-json',
    );
    assertNoUnexpectedArgs(args);
    return buildWebSocketPayload(operation, {
      urlTemplate: `wss://${base.hostname}:6113/shelly/wss/hk_sock?t=<secret:${CLOUD_ACCESS_TOKEN_SECRET}>`,
      message: {
        event: 'Shelly:CommandRequest',
        trid,
        deviceId,
        data: {
          cmd,
          params,
        },
      },
    });
  }

  if (operation === 'cloud-set-switch') {
    requireGrant(args, operation);
    const json = {
      id: parseDeviceId(args),
      on: parseBooleanValue(popFlag(args, '--on'), '--on'),
    };
    const channel = popFlag(args, '--channel');
    if (channel !== undefined)
      json.channel = parseNonNegativeInteger(channel, '--channel');
    const toggleAfter = popFlag(args, '--toggle-after');
    if (toggleAfter !== undefined) {
      const parsed = parseNumber(toggleAfter, '--toggle-after');
      if (parsed <= 0) die('--toggle-after must be greater than 0.');
      json.toggle_after = parsed;
    }
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: cloudUrl(base, '/v2/devices/api/set/switch'),
      method: 'POST',
      json,
    });
  }

  if (operation === 'cloud-set-light') {
    requireGrant(args, operation);
    const json = { id: parseDeviceId(args) };
    let hasAction = false;
    const channel = popFlag(args, '--channel');
    if (channel !== undefined)
      json.channel = parseNonNegativeInteger(channel, '--channel');
    const on = popFlag(args, '--on');
    if (on !== undefined) {
      json.on = parseBooleanValue(on, '--on');
      hasAction = true;
    }
    const toggleAfter = popFlag(args, '--toggle-after');
    if (toggleAfter !== undefined) {
      json.toggle_after = parsePositiveNumber(toggleAfter, '--toggle-after');
      hasAction = true;
    }
    const mode = popFlag(args, '--mode');
    if (mode !== undefined) {
      if (!['color', 'white'].includes(mode))
        die('--mode must be color or white.');
      json.mode = mode;
      hasAction = true;
    }
    for (const [flag, property, min, max] of [
      ['--temperature', 'temperature', 2700, 7000],
      ['--brightness', 'brightness', 0, 100],
      ['--red', 'red', 0, 255],
      ['--green', 'green', 0, 255],
      ['--blue', 'blue', 0, 255],
      ['--white', 'white', 0, 255],
      ['--gain', 'gain', 0, 100],
      ['--effect', 'effect', 0, 6],
    ]) {
      const value = popFlag(args, flag);
      if (value !== undefined) {
        json[property] = parseBoundedNumber(value, flag, min, max);
        hasAction = true;
      }
    }
    if (!hasAction) {
      die('cloud-set-light requires at least one light command field.');
    }
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: cloudUrl(base, '/v2/devices/api/set/light'),
      method: 'POST',
      json,
    });
  }

  if (operation === 'cloud-set-cover') {
    requireGrant(args, operation);
    const json = { id: parseDeviceId(args) };
    let hasAction = false;
    const channel = popFlag(args, '--channel');
    if (channel !== undefined)
      json.channel = parseNonNegativeInteger(channel, '--channel');
    const position = popFlag(args, '--position');
    if (position !== undefined) {
      const normalized = String(position).trim().toLowerCase();
      if (['open', 'close', 'stop'].includes(normalized)) {
        json.position = normalized;
      } else {
        json.position = parseBoundedNumber(position, '--position', 0, 100);
      }
      hasAction = true;
    }
    const relative = popFlag(args, '--relative');
    if (relative !== undefined) {
      json.relative = parseBoundedNumber(relative, '--relative', -100, 100);
      hasAction = true;
    }
    const duration = popFlag(args, '--duration');
    if (duration !== undefined) {
      json.duration = parsePositiveNumber(duration, '--duration');
      hasAction = true;
    }
    const slatPosition = popFlag(args, '--slat-position');
    if (slatPosition !== undefined) {
      json.slatPosition = parseBoundedNumber(
        slatPosition,
        '--slat-position',
        0,
        100,
      );
      hasAction = true;
    }
    const slatRelative = popFlag(args, '--slat-relative');
    if (slatRelative !== undefined) {
      json.slatRelative = parseBoundedNumber(
        slatRelative,
        '--slat-relative',
        -100,
        100,
      );
      hasAction = true;
    }
    if (json.position !== undefined && json.relative !== undefined) {
      die('--position and --relative cannot be used together.');
    }
    if (json.slatPosition !== undefined && json.slatRelative !== undefined) {
      die('--slat-position and --slat-relative cannot be used together.');
    }
    if (!hasAction) {
      die('cloud-set-cover requires at least one cover command field.');
    }
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: cloudUrl(base, '/v2/devices/api/set/cover'),
      method: 'POST',
      json,
    });
  }

  die(`Unsupported cloud operation: ${operation}`);
}

function parsePositiveNumber(value, label) {
  const parsed = parseNumber(value, label);
  if (parsed <= 0) die(`${label} must be greater than 0.`);
  return parsed;
}

function parseBoundedNumber(value, label, min, max) {
  const parsed = parseNumber(value, label);
  if (parsed < min || parsed > max) {
    die(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function commandId(resource, action) {
  return `${resource}.${action}`;
}

function exposeCommand(payload, resource, action) {
  return {
    ...payload,
    operation: commandId(resource, action),
  };
}

function usesCloudRoute(args) {
  return hasFlag(args, '--cloud-host') || hasFlag(args, '--device-id');
}

function buildDeviceCommand(action, args) {
  const operationByAction = {
    info: 'local-gen2-info',
    status: usesCloudRoute(args) ? 'cloud-get-state' : 'local-gen2-status',
    config: 'local-gen2-config',
    methods: 'local-gen2-methods',
    components: 'local-gen2-components',
  };
  const operation = operationByAction[action];
  if (!operation) die(`Unsupported device action: ${action || '(missing)'}`);
  const payload = operation.startsWith('cloud-')
    ? buildCloud(operation, args)
    : buildLocalGen2(operation, args);
  return exposeCommand(payload, 'device', action);
}

function buildGen1Command(action, args) {
  const operationByAction = {
    get: 'local-gen1-get',
    set: 'local-gen1-set',
  };
  const operation = operationByAction[action];
  if (!operation) die(`Unsupported gen1 action: ${action || '(missing)'}`);
  return exposeCommand(buildLocalGen1(operation, args), 'gen1', action);
}

function buildRpcCommand(action, args) {
  const builders = {
    get: buildGenericRpcGet,
    call: buildGenericRpcCall,
  };
  const builder = builders[action];
  if (!builder) die(`Unsupported rpc action: ${action || '(missing)'}`);
  return exposeCommand(builder(args), 'rpc', action);
}

function buildCoverCommand(action, args) {
  let operation;
  let commandArgs = args;
  if (
    action === 'goto' &&
    !hasAnyFlag(args, [
      '--position',
      '--relative',
      '--slat-position',
      '--slat-relative',
    ])
  ) {
    die(
      'cover.goto requires --position, --relative, --slat-position, or --slat-relative.',
    );
  }
  if (usesCloudRoute(args)) {
    if (action === 'status') {
      operation = 'cloud-get-state';
      commandArgs = addDefaultRepeatedFlag(args, '--select', ['status']);
    } else if (action === 'config') {
      operation = 'cloud-get-state';
      commandArgs = addDefaultRepeatedFlag(args, '--select', ['settings']);
    } else if (['open', 'close', 'stop'].includes(action)) {
      operation = 'cloud-set-cover';
      commandArgs = hasFlag(args, '--position')
        ? args
        : [...args, '--position', action === 'close' ? 'close' : action];
    } else if (action === 'goto') {
      operation = 'cloud-set-cover';
    } else {
      die(`Unsupported cover action: ${action || '(missing)'}`);
    }
    return exposeCommand(buildCloud(operation, commandArgs), 'cover', action);
  }

  const operationByAction = {
    config: 'local-gen2-cover-config',
    status: 'local-gen2-cover-status',
    open: 'local-gen2-cover-open',
    close: 'local-gen2-cover-close',
    stop: 'local-gen2-cover-stop',
    goto: 'local-gen2-cover-goto-position',
  };
  operation = operationByAction[action];
  if (!operation) die(`Unsupported cover action: ${action || '(missing)'}`);
  return exposeCommand(buildLocalGen2(operation, commandArgs), 'cover', action);
}

function buildSwitchCommand(action, args) {
  if (usesCloudRoute(args)) {
    if (action === 'status') {
      const payload = buildCloud(
        'cloud-get-state',
        addDefaultRepeatedFlag(args, '--select', ['status']),
      );
      return exposeCommand(payload, 'switch', action);
    }
    if (action === 'set') {
      return exposeCommand(
        buildCloud('cloud-set-switch', args),
        'switch',
        action,
      );
    }
    die(`Unsupported cloud switch action: ${action || '(missing)'}`);
  }

  const operationByAction = {
    status: 'local-gen2-switch-status',
    set: 'local-gen2-switch-set',
    toggle: 'local-gen2-switch-toggle',
  };
  const operation = operationByAction[action];
  if (!operation) die(`Unsupported switch action: ${action || '(missing)'}`);
  return exposeCommand(buildLocalGen2(operation, args), 'switch', action);
}

function buildRelayCommand(action, args) {
  const operationByAction = {
    status: 'local-gen1-relay-status',
    set: 'local-gen1-relay-set',
  };
  const operation = operationByAction[action];
  if (!operation) die(`Unsupported relay action: ${action || '(missing)'}`);
  return exposeCommand(buildLocalGen1(operation, args), 'relay', action);
}

function buildLightCommand(action, args) {
  if (action !== 'set')
    die(`Unsupported light action: ${action || '(missing)'}`);
  if (
    !hasAnyFlag(args, [
      '--on',
      '--toggle-after',
      '--mode',
      '--temperature',
      '--brightness',
      '--red',
      '--green',
      '--blue',
      '--white',
      '--gain',
      '--effect',
    ])
  ) {
    die('light.set requires at least one light command field.');
  }
  return exposeCommand(buildCloud('cloud-set-light', args), 'light', action);
}

function buildCloudCommand(action, args) {
  const operationByAction = {
    state: 'cloud-get-state',
    'oauth-token': 'cloud-oauth-token',
    'all-status': 'cloud-all-status',
    'websocket-url': 'cloud-websocket-url',
    'websocket-command': 'cloud-websocket-command',
  };
  const operation = operationByAction[action];
  if (!operation) die(`Unsupported cloud action: ${action || '(missing)'}`);
  return exposeCommand(buildCloud(operation, args), 'cloud', action);
}

function buildDomainCommand(resource, action, args) {
  if (!DOMAIN_COMMANDS.has(resource)) {
    die(`Unsupported resource: ${resource || '(missing)'}`);
  }
  const publicOperation = commandId(resource, action);
  if (
    domainTier(resource, action) === 'amber' &&
    !args.includes('--operator-grant')
  ) {
    die(
      `${publicOperation} is amber; pass --operator-grant only after explicit operator approval.`,
    );
  }
  const builders = {
    device: buildDeviceCommand,
    gen1: buildGen1Command,
    rpc: buildRpcCommand,
    cover: buildCoverCommand,
    switch: buildSwitchCommand,
    relay: buildRelayCommand,
    light: buildLightCommand,
    cloud: buildCloudCommand,
  };
  return builders[resource](action, args);
}

function domainTier(resource, action) {
  if (
    resource === 'cover' &&
    ['open', 'close', 'stop', 'goto'].includes(action)
  ) {
    return 'amber';
  }
  if (resource === 'switch' && ['set', 'toggle'].includes(action)) {
    return 'amber';
  }
  if (resource === 'relay' && action === 'set') return 'amber';
  if (resource === 'light' && action === 'set') return 'amber';
  if (resource === 'gen1' && action === 'set') return 'amber';
  if (resource === 'rpc' && action === 'call') return 'amber';
  if (resource === 'cloud' && action === 'websocket-command') return 'amber';
  return 'green';
}

function buildRequest(argv) {
  const args = normalizeFlagAliases([...argv]);
  const format = popFlag(args, '--format', 'pretty');
  if (!['json', 'pretty'].includes(format))
    die('--format must be json or pretty.');
  const wantsApprovalPlan = popBoolean(args, '--approval-plan');
  const command = args.shift();
  if (command === 'approval-plan') {
    return buildApprovalPlan(args);
  }
  const action = args.shift();
  if (wantsApprovalPlan) {
    return buildApprovalPlan([command, action, ...args]);
  }
  return buildDomainCommand(command, action, args);
}

function buildApprovalPlan(args) {
  args = normalizeFlagAliases([...args]);
  const resource = args.shift();
  const action = args.shift();
  if (!DOMAIN_COMMANDS.has(resource)) {
    die(`Unsupported resource: ${resource || '(missing)'}`);
  }
  const publicOperation = commandId(resource, action);
  if (domainTier(resource, action) !== 'amber') {
    die(
      `approval-plan is only needed for amber operations: ${publicOperation}.`,
    );
  }
  if (args.includes('--operator-grant')) {
    die('approval-plan must be built before --operator-grant is added.');
  }

  const approvedArgs = [resource, action, ...args, '--operator-grant'];
  const approvedPayload = buildRequest(['--format', 'json', ...approvedArgs]);
  const approvedHelperCommand = [
    'node',
    'skills/shelly/shelly.cjs',
    '--format',
    'json',
    ...approvedArgs,
  ];
  const requestTarget =
    approvedPayload.httpRequest || approvedPayload.webSocket;
  const target = new URL(requestTarget.url || requestTarget.urlTemplate);
  const plan = {
    command: 'approval-plan',
    operation: approvedPayload.operation,
    stakesTier: approvedPayload.stakesTier,
    target: {
      host: target.host,
      path: target.pathname,
      method: approvedPayload.httpRequest
        ? approvedPayload.httpRequest.method
        : 'WEBSOCKET',
    },
    approvedHelperCommand,
    approvedHelperCommandText: approvedHelperCommand.map(shellQuote).join(' '),
    approvalRequired: true,
    approvalBoundary:
      'Stop after producing this plan. Do not run approvedHelperCommandText until the operator confirms in a later message.',
    approvalSummary:
      'After explicit operator approval in a later message, run approvedHelperCommandText exactly. The helper executes HTTP operations through the HybridClaw gateway.',
    costMeasurement: COST_MEASUREMENT,
  };
  if (approvedPayload.rpcMethod) {
    plan.rpcMethod = approvedPayload.rpcMethod;
  } else if (approvedPayload.httpRequest?.json?.method) {
    plan.rpcMethod = approvedPayload.httpRequest.json.method;
  }
  if (approvedPayload.rpcMethod && approvedPayload.httpRequest?.json) {
    plan.params = approvedPayload.httpRequest.json;
  } else if (approvedPayload.httpRequest?.json?.params) {
    plan.params = approvedPayload.httpRequest.json.params;
  } else if (approvedPayload.httpRequest?.json) {
    plan.params = approvedPayload.httpRequest.json;
  } else if (approvedPayload.webSocket?.message) {
    plan.message = approvedPayload.webSocket.message;
  }
  return plan;
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
  const emitRequestOnly = popBoolean(args, '--request');
  const payload = buildRequest(args);
  if (!emitRequestOnly && payload.httpRequest) {
    const result = await executeGatewayRequest(payload.httpRequest);
    const output = {
      command: 'live',
      operation: payload.operation,
      stakesTier: payload.stakesTier,
      request: {
        url: payload.httpRequest.url,
        method: payload.httpRequest.method,
      },
      result,
      costMeasurement: payload.costMeasurement,
    };
    process.stdout.write(
      JSON.stringify(output, null, format === 'pretty' ? 2 : 0),
    );
    process.stdout.write('\n');
    return;
  }
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
};
