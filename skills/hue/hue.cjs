#!/usr/bin/env node
'use strict';

const DEFAULT_TIMEOUT_MS = 15_000;
const LOCAL_HOST_ENV = 'HUE_BRIDGE_HOST';
const LOCAL_KEY_SECRET = 'HUE_APPLICATION_KEY';
const REMOTE_CLIENT_ID_SECRET = 'HUE_REMOTE_CLIENT_ID';
const REMOTE_CLIENT_SECRET_SECRET = 'HUE_REMOTE_CLIENT_SECRET';
const REMOTE_REFRESH_TOKEN_SECRET = 'HUE_REMOTE_REFRESH_TOKEN';
const REMOTE_ACCESS_TOKEN_SECRET = 'HUE_REMOTE_ACCESS_TOKEN';
const REMOTE_BRIDGE_ID_SECRET = 'HUE_REMOTE_BRIDGE_ID';
const WRITE_GRANT = 'approve-hue-write';
const BRIDGE_CONFIG_GRANT = 'approve-hue-bridge-config';
const COST_MEASUREMENT = { system: 'UsageTotals', subLimitKey: 'hue' };
const ENV_TEMPLATE_RE = /^<env:([A-Z][A-Z0-9_]{0,127})>$/u;

const CLIP_RESOURCES = {
  bridge: 'bridge',
  device: 'device',
  light: 'light',
  'grouped-light': 'grouped_light',
  room: 'room',
  zone: 'zone',
  scene: 'scene',
  motion: 'motion',
  temperature: 'temperature',
  'light-level': 'light_level',
  button: 'button',
  behavior: 'behavior_instance',
  entertainment: 'entertainment_configuration',
};

const RESOURCE_ALIASES = {
  bridges: 'bridge',
  devices: 'device',
  lights: 'light',
  'grouped-lights': 'grouped-light',
  rooms: 'room',
  zones: 'zone',
  scenes: 'scene',
  motions: 'motion',
  temperatures: 'temperature',
  'light-levels': 'light-level',
  buttons: 'button',
  behaviors: 'behavior',
  'behavior-instance': 'behavior',
  'behavior-instances': 'behavior',
  entertainment_configuration: 'entertainment',
  'entertainment-configuration': 'entertainment',
  'entertainment-configurations': 'entertainment',
};

function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printHelp() {
  process.stdout.write(`Hue request helper

Usage:
  node skills/hue/hue.cjs [--format json|pretty] <subject> <verb> [flags]

Local reads:
  light list [--host URL]
  bridge|device|light|grouped-light|room|zone|scene list [--host URL]
  bridge|device|light|grouped-light|room|zone|scene get --id ID [--host URL]
  motion|temperature|light-level|button|behavior|entertainment list [--host URL]
  eventstream read [--duration 30s] [--host URL]

Local writes:
  light on|off --id ID
  light brightness --id ID --pct 60
  light color --id ID --xy 0.4317,0.4147
  light color --id ID --mirek 366
  grouped-light on|off --id ID
  grouped-light brightness --id ID --pct 60
  grouped-light color --id ID --xy 0.4317,0.4147
  scene recall --id ID
  behavior enable|disable --id ID
  bridge timezone --id ID --timezone Europe/Berlin

Setup request:
  bridge status
  bridge link --app-name hybridclaw --instance-name lab

Remote API:
  remote oauth-token
  remote bridge list
  remote light|room list [--bridge ID]
`);
}

function popFlag(args, name, defaultValue = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return defaultValue;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) die(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function requireText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function requireFlag(args, name, defaultValue = undefined) {
  return requireText(popFlag(args, name, defaultValue), name);
}

function assertNoArgs(args) {
  if (args.length > 0) die(`Unexpected argument: ${args[0]}`);
}

function parsePct(value) {
  const pct = Number(requireText(value, '--pct'));
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    die('--pct must be a number between 0 and 100.');
  }
  return pct;
}

function parseInteger(value, label, min, max) {
  const raw = requireText(value, label);
  if (!/^\d+$/u.test(raw)) die(`${label} must be an integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    die(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseXy(value) {
  const parts = requireText(value, '--xy')
    .split(',')
    .map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    die('--xy must use x,y numeric coordinates.');
  }
  const [x, y] = parts;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    die('--xy values must be between 0 and 1.');
  }
  return { x, y };
}

function parseDurationMs(value) {
  const raw = requireText(value, '--duration');
  const match = raw.match(/^(\d+)(ms|s|m)?$/u);
  if (!match) die('--duration must look like 5000ms, 30s, or 1m.');
  const amount = Number(match[1]);
  const unit = match[2] || 'ms';
  const ms = unit === 'm' ? amount * 60_000 : unit === 's' ? amount * 1_000 : amount;
  if (!Number.isSafeInteger(ms) || ms < 1_000 || ms > 120_000) {
    die('--duration must be between 1s and 120s.');
  }
  return ms;
}

function normalizeSubject(subject) {
  const normalized = String(subject || '').trim().toLowerCase();
  return RESOURCE_ALIASES[normalized] || normalized;
}

function normalizeBaseUrl(value, label, requireHttps = true) {
  const raw = requireText(value, label);
  if (raw.includes('<secret:')) die(`${label} URL placeholder must use <env:NAME>.`);
  if (raw.includes('<env:')) {
    const normalized = raw.replace(/\/+$/u, '');
    if (!ENV_TEMPLATE_RE.test(normalized)) die(`${label} env placeholder must be exactly <env:NAME>.`);
    return normalized;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    die(`${label} must be a valid URL such as https://192.0.2.30.`);
  }
  if (requireHttps && parsed.protocol !== 'https:') die(`${label} must use https.`);
  if (parsed.username || parsed.password) die(`${label} must not contain credentials.`);
  if (parsed.search || parsed.hash) die(`${label} must not contain query strings or fragments.`);
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed.toString().replace(/\/+$/u, '');
}

function baseFromArgs(args) {
  return normalizeBaseUrl(popFlag(args, '--host') || `<env:${LOCAL_HOST_ENV}>`, '--host');
}

function appendPath(base, suffix) {
  if (ENV_TEMPLATE_RE.test(base)) return `${base}${suffix}`;
  const parsed = new URL(base);
  parsed.pathname = `${parsed.pathname}${suffix}`.replace(/\/{2,}/gu, '/');
  return parsed.toString();
}

function clipUrl(base, resource, id) {
  return appendPath(base, `/clip/v2/resource/${resource}${id ? `/${encodeURIComponent(id)}` : ''}`);
}

function localHeaders() {
  return [{ name: 'hue-application-key', secretName: LOCAL_KEY_SECRET, prefix: 'none' }];
}

function remoteHeaders() {
  return [{ name: 'Authorization', secretName: REMOTE_ACCESS_TOKEN_SECRET, prefix: 'Bearer' }];
}

function requestPayload(operation, stakesTier, httpRequest, target = undefined) {
  return {
    command: 'http-request',
    operation,
    stakesTier,
    httpRequest: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: 1_000_000,
      skillName: 'hue',
      stakesTier,
      ...httpRequest,
    },
    ...(target ? { target } : {}),
    costMeasurement: COST_MEASUREMENT,
  };
}

function localRequest(operation, tier, options) {
  return requestPayload(
    operation,
    tier,
    {
      url: options.url,
      method: options.method || 'GET',
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.json !== undefined ? { json: options.json } : {}),
      ...(options.form !== undefined ? { form: options.form } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
      secretHeaders: localHeaders(),
      replaceSecretPlaceholders: true,
      allowSelfSignedTls: true,
    },
    options.target,
  );
}

function remoteRequest(operation, options) {
  return requestPayload(
    operation,
    'amber',
    {
      url: options.url,
      method: options.method || 'GET',
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.form !== undefined ? { form: options.form } : {}),
      ...(options.json !== undefined ? { json: options.json } : {}),
      ...(options.captureResponseFields ? { captureResponseFields: options.captureResponseFields } : {}),
      secretHeaders: options.secretHeaders || remoteHeaders(),
      replaceSecretPlaceholders: true,
    },
    options.target,
  );
}

function buildResourceRead(subject, verb, args) {
  const resource = CLIP_RESOURCES[subject];
  if (!resource) die(`Unsupported Hue subject: ${subject}`);
  const base = baseFromArgs(args);
  const id = verb === 'get' ? requireFlag(args, '--id') : undefined;
  if (verb !== 'list' && verb !== 'get') die(`Unsupported ${subject} verb: ${verb}`);
  assertNoArgs(args);
  return localRequest(`local-${resource.replace(/_/gu, '-')}-${verb}`, 'green', {
    url: clipUrl(base, resource, id),
    target: { resource, ...(id ? { id } : {}) },
  });
}

function actionForOnOff(verb) {
  if (verb === 'on') return { on: { on: true } };
  if (verb === 'off') return { on: { on: false } };
  return null;
}

function colorAction(args) {
  const xy = popFlag(args, '--xy');
  const mirek = popFlag(args, '--mirek');
  if ((xy && mirek) || (!xy && !mirek)) die('color requires exactly one of --xy or --mirek.');
  return xy
    ? { color: { xy: parseXy(xy) } }
    : { color_temperature: { mirek: parseInteger(mirek, '--mirek', 153, 500) } };
}

function buildLightWrite(subject, verb, args) {
  const resource = subject === 'grouped-light' ? 'grouped_light' : 'light';
  const id = requireFlag(args, '--id');
  const base = baseFromArgs(args);
  const onOff = actionForOnOff(verb);
  const json =
    onOff ||
    (verb === 'brightness'
      ? { dimming: { brightness: parsePct(popFlag(args, '--pct')) } }
      : verb === 'color'
        ? colorAction(args)
        : null);
  if (!json) die(`Unsupported ${subject} verb: ${verb}`);
  assertNoArgs(args);
  const operationSubject = subject === 'grouped-light' ? 'group' : subject;
  return {
    ...localRequest(`local-${operationSubject}-${verb}`, 'amber', {
      url: clipUrl(base, resource, id),
      method: 'PUT',
      json,
      target: { type: resource, id, action: verb },
    }),
    requiredGrant: WRITE_GRANT,
  };
}

function buildScene(subject, verb, args) {
  if (verb === 'list' || verb === 'get') return buildResourceRead(subject, verb, args);
  if (verb !== 'recall') die(`Unsupported scene verb: ${verb}`);
  const id = requireFlag(args, '--id');
  const base = baseFromArgs(args);
  assertNoArgs(args);
  return {
    ...localRequest('local-scene-recall', 'amber', {
      url: clipUrl(base, 'scene', id),
      method: 'PUT',
      json: { recall: { action: 'active' } },
      target: { type: 'scene', id, action: 'recall' },
    }),
    requiredGrant: WRITE_GRANT,
  };
}

function buildBehavior(subject, verb, args) {
  if (verb === 'list' || verb === 'get') return buildResourceRead(subject, verb, args);
  if (verb !== 'enable' && verb !== 'disable') die(`Unsupported behavior verb: ${verb}`);
  const id = requireFlag(args, '--id');
  const base = baseFromArgs(args);
  assertNoArgs(args);
  return {
    ...localRequest(`local-behavior-${verb}`, 'amber', {
      url: clipUrl(base, 'behavior_instance', id),
      method: 'PUT',
      json: { enabled: verb === 'enable' },
      target: { type: 'behavior_instance', id, action: verb },
    }),
    requiredGrant: WRITE_GRANT,
  };
}

function buildBridge(verb, args) {
  if (verb === 'list' || verb === 'get') return buildResourceRead('bridge', verb, args);
  if (verb === 'status') {
    const host = baseFromArgs(args);
    assertNoArgs(args);
    return requestPayload(
      'local-bridge-status',
      'green',
      {
        url: appendPath(host, '/api/config'),
        method: 'GET',
        timeoutMs: 5_000,
        maxResponseBytes: 100_000,
        skillName: 'hue',
        stakesTier: 'green',
        replaceSecretPlaceholders: true,
        allowSelfSignedTls: true,
      },
      { resource: 'bridge-status', host },
    );
  }
  if (verb === 'link') {
    const host = baseFromArgs(args);
    const appName = requireText(popFlag(args, '--app-name', 'hybridclaw'), '--app-name');
    const instanceName = requireText(popFlag(args, '--instance-name', 'default'), '--instance-name');
    assertNoArgs(args);
    return requestPayload(
      'local-link-button',
      'amber',
      {
        url: appendPath(host, '/api'),
        method: 'POST',
        timeoutMs: 5_000,
        maxResponseBytes: 50_000,
        skillName: 'hue',
        stakesTier: 'amber',
        json: { devicetype: `${appName}#${instanceName}` },
        replaceSecretPlaceholders: true,
        allowSelfSignedTls: true,
      },
      { resource: 'link-button', host },
    );
  }
  if (verb === 'timezone') {
    const id = requireFlag(args, '--id');
    const timezone = requireFlag(args, '--timezone');
    const base = baseFromArgs(args);
    assertNoArgs(args);
    return {
      ...localRequest('local-bridge-config-timezone', 'red', {
        url: clipUrl(base, 'bridge', id),
        method: 'PUT',
        json: { time_zone: { time_zone: timezone } },
        target: { type: 'bridge', id, action: 'timezone', timezone },
      }),
      requiredGrant: BRIDGE_CONFIG_GRANT,
    };
  }
  die(`Unsupported bridge verb: ${verb}`);
}

function buildEventstream(verb, args) {
  if (verb !== 'read') die(`Unsupported eventstream verb: ${verb}`);
  const base = baseFromArgs(args);
  const timeoutMs = parseDurationMs(popFlag(args, '--duration', '30s'));
  assertNoArgs(args);
  return localRequest('local-eventstream', 'green', {
    url: appendPath(base, '/eventstream/clip/v2'),
    timeoutMs,
    maxResponseBytes: 2_000_000,
    headers: { Accept: 'text/event-stream' },
    target: { resource: 'eventstream' },
  });
}

function remoteBase(args) {
  return normalizeBaseUrl(popFlag(args, '--remote-host', 'https://api.meethue.com'), '--remote-host');
}

function remoteClipUrl(base, resource, bridgeId) {
  const query = bridgeId.includes('<secret:') ? bridgeId : encodeURIComponent(bridgeId);
  return `${appendPath(base, `/route/clip/v2/resource/${resource}`)}?bridge_id=${query}`;
}

function buildRemote(args) {
  const subject = normalizeSubject(requireText(args.shift(), 'remote subject'));
  const rawVerb = args[0] && !String(args[0]).startsWith('--') ? args.shift() : undefined;
  const verb = String(rawVerb || (subject === 'oauth-token' ? 'get' : 'list')).toLowerCase();
  const base = remoteBase(args);
  if (subject === 'oauth-token') {
    if (verb !== 'get' && verb !== 'refresh') die('remote oauth-token supports get|refresh.');
    assertNoArgs(args);
    return remoteRequest('remote-oauth-token', {
      url: appendPath(base, '/v2/oauth2/token'),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      secretHeaders: [],
      form: {
        grant_type: 'refresh_token',
        refresh_token: `<secret:${REMOTE_REFRESH_TOKEN_SECRET}>`,
        client_id: `<secret:${REMOTE_CLIENT_ID_SECRET}>`,
        client_secret: `<secret:${REMOTE_CLIENT_SECRET_SECRET}>`,
      },
      captureResponseFields: [
        { jsonPath: 'access_token', secretName: REMOTE_ACCESS_TOKEN_SECRET },
        { jsonPath: 'refresh_token', secretName: REMOTE_REFRESH_TOKEN_SECRET },
      ],
      target: { resource: 'remote-oauth-token' },
    });
  }
  if (subject === 'bridge') {
    if (verb !== 'list') die('remote bridge supports list.');
    assertNoArgs(args);
    return remoteRequest('remote-bridges', {
      url: appendPath(base, '/route/api/0/config'),
      target: { resource: 'bridge', remote: true },
    });
  }
  const resource = CLIP_RESOURCES[subject];
  if (!resource || verb !== 'list') die(`Unsupported remote command: ${subject} ${verb}`);
  const bridgeId = popFlag(args, '--bridge', `<secret:${REMOTE_BRIDGE_ID_SECRET}>`);
  assertNoArgs(args);
  return remoteRequest(`remote-${resource.replace(/_/gu, '-')}-list`, {
    url: remoteClipUrl(base, resource, bridgeId),
    target: { resource, bridgeId, remote: true },
  });
}

function buildRequest(inputArgs) {
  const args = [...inputArgs];
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return undefined;
  }
  popFlag(args, '--format', 'pretty');
  const subject = normalizeSubject(requireText(args.shift(), 'subject'));
  const verb = requireText(args.shift(), 'verb').toLowerCase();

  if (subject === 'remote') return buildRemote([verb, ...args]);
  if (subject === 'eventstream') return buildEventstream(verb, args);
  if (subject === 'bridge') return buildBridge(verb, args);
  if (subject === 'light' || subject === 'grouped-light') {
    return verb === 'list' || verb === 'get'
      ? buildResourceRead(subject, verb, args)
      : buildLightWrite(subject, verb, args);
  }
  if (subject === 'scene') return buildScene(subject, verb, args);
  if (subject === 'behavior') return buildBehavior(subject, verb, args);
  return buildResourceRead(subject, verb, args);
}

async function main() {
  const args = process.argv.slice(2);
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'pretty';
  const payload = buildRequest(args);
  if (payload === undefined) return;
  process.stdout.write(JSON.stringify(payload, null, format === 'pretty' ? 2 : 0));
  process.stdout.write('\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildRequest };
