#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const LOCAL_HOST_ENV = 'HUE_BRIDGE_HOST';
const LOCAL_KEY_SECRET = 'HUE_APPLICATION_KEY';
const REMOTE_CLIENT_ID_SECRET = 'HUE_REMOTE_CLIENT_ID';
const REMOTE_CLIENT_SECRET_SECRET = 'HUE_REMOTE_CLIENT_SECRET';
const REMOTE_REFRESH_TOKEN_SECRET = 'HUE_REMOTE_REFRESH_TOKEN';
const REMOTE_ACCESS_TOKEN_SECRET = 'HUE_REMOTE_ACCESS_TOKEN';
const REMOTE_BRIDGE_ID_SECRET = 'HUE_REMOTE_BRIDGE_ID';
const WRITE_GRANT = 'approve-hue-write';
const BRIDGE_CONFIG_GRANT = 'approve-hue-bridge-config';
const COST_MEASUREMENT = {
  system: 'UsageTotals',
  subLimitKey: 'hue',
};

const CLIP_V2_RESOURCES = {
  bridge: 'bridge',
  device: 'device',
  devices: 'device',
  light: 'light',
  lights: 'light',
  'grouped-light': 'grouped_light',
  'grouped-lights': 'grouped_light',
  grouped_light: 'grouped_light',
  room: 'room',
  rooms: 'room',
  zone: 'zone',
  zones: 'zone',
  scene: 'scene',
  scenes: 'scene',
  motion: 'motion',
  'motion-sensor': 'motion',
  'motion-sensors': 'motion',
  temperature: 'temperature',
  'temperature-sensor': 'temperature',
  'temperature-sensors': 'temperature',
  'light-level': 'light_level',
  'light-levels': 'light_level',
  button: 'button',
  buttons: 'button',
  'behavior-instance': 'behavior_instance',
  'behavior-instances': 'behavior_instance',
  behavior_instance: 'behavior_instance',
  'entertainment-configuration': 'entertainment_configuration',
  'entertainment-configurations': 'entertainment_configuration',
  entertainment_configuration: 'entertainment_configuration',
};

const READ_ALIASES = new Set([
  ...Object.keys(CLIP_V2_RESOURCES),
  'eventstream',
  'remote-bridges',
  'remote-lights',
  'remote-oauth-token',
]);
const SECRET_TEMPLATE_RE = /^<secret:([A-Z][A-Z0-9_]{0,127})>$/u;
const ENV_TEMPLATE_RE = /^<env:([A-Z][A-Z0-9_]{0,127})>$/u;
const LOCAL_SECRET_REF_POLICY =
  'The Hue application key is emitted only as a secretHeaders reference. Never paste the application key into chat or helper arguments.';
const LOCAL_MUTATION_SECRET_REF_POLICY =
  'The Hue application key is emitted only as a secretHeaders reference. Mutating operations require an exact operator grant.';
const LOCAL_EVENTSTREAM_SECRET_REF_POLICY =
  'The Hue application key is emitted only as a secretHeaders reference. Eventstream output may reveal occupancy; keep diagnostic windows short.';
const REMOTE_SECRET_REF_POLICY =
  'Hue Remote API calls are off-LAN amber operations. Remote tokens and bridge id are SecretRef-backed.';
const REMOTE_MUTATION_SECRET_REF_POLICY =
  'The Hue Remote API access token is emitted only as a secretHeaders reference. Mutating off-LAN operations require an exact operator grant.';
const REMOTE_BRIDGE_SECRETS = [
  REMOTE_ACCESS_TOKEN_SECRET,
  REMOTE_BRIDGE_ID_SECRET,
];

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function printHelp() {
  console.log(`Hue skill helper

Usage:
  node skills/hue/hue.cjs [--format json|pretty] [--request] http-request <resource> [flags]
  node skills/hue/hue.cjs [--format json|pretty] plan <operation> [flags]
  node skills/hue/hue.cjs [--format json|pretty] link --host https://192.0.2.30 --app-name hybridclaw --instance-name lab

Read resources:
  http-request bridge|devices|lights|grouped-lights|rooms|zones|scenes
  http-request motion-sensors|temperature-sensors|light-levels|buttons
  http-request behavior-instances|entertainment-configurations
  http-request eventstream --duration 30s
  http-request remote-bridges
  http-request remote-lights --bridge <id>
  http-request remote-oauth-token

Write plans:
  plan light-on --light <id>
  plan light-off --light <id>
  plan light-brightness --light <id> --pct 60
  plan light-color --light <id> --xy 0.4317,0.4147
  plan light-color --light <id> --mirek 366
  plan group-on --group <grouped_light_id>
  plan group-brightness --group <grouped_light_id> --pct 60
  plan group-recall-scene --scene <id>
  plan behavior-disable --behavior <id>
  plan scene-create --name Evening --group <room_id> --group-type room --actions-json '[{"target":{"rid":"<light_id>","rtype":"light"},"action":{"on":{"on":true}}}]'
  plan behavior-create --name Vacation --configuration-json '{"script_id":"..."}'
  plan bridge-config-timezone --timezone Europe/Berlin

Environment:
  HYBRIDCLAW_GATEWAY_URL   gateway base URL for live execution (default: http://127.0.0.1:9090)
  HYBRIDCLAW_GATEWAY_TOKEN gateway bearer token for live execution
  HUE_BRIDGE_HOST          env store bridge URL used through <env:HUE_BRIDGE_HOST>
  HUE_APPLICATION_KEY      stored CLIP v2 application key, emitted only as a secretHeaders ref
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

function assertNoUnexpectedArgs(args) {
  if (args.length > 0) {
    die(`Unexpected argument: ${args[0]}`);
  }
}

function requireText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function requireFlag(args, name, defaultValue = undefined) {
  return requireText(popFlag(args, name, defaultValue), name);
}

function parsePct(value, label = '--pct') {
  const parsed = Number(requireText(value, label));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    die(`${label} must be a number between 0 and 100.`);
  }
  return parsed;
}

function parseIntegerRange(value, label, min, max) {
  const raw = requireText(value, label);
  if (!/^\d+$/u.test(raw)) die(`${label} must be an integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    die(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseBooleanValue(value, label) {
  const normalized = requireText(value, label).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  die(`${label} must be true or false.`);
}

function parseJson(value, label) {
  const raw = requireText(value, label);
  try {
    return JSON.parse(raw);
  } catch (error) {
    die(`${label} must be valid JSON: ${error.message}`);
  }
}

function parseJsonObject(value, label) {
  const parsed = parseJson(value, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseJsonArray(value, label) {
  const parsed = parseJson(value, label);
  if (!Array.isArray(parsed)) {
    die(`${label} must be a JSON array.`);
  }
  return parsed;
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateHueActionBody(action, label) {
  if (!isObject(action)) die(`${label} action must be a JSON object.`);
  const allowed = new Set(['on', 'dimming', 'color', 'color_temperature']);
  for (const key of Object.keys(action)) {
    if (!allowed.has(key)) die(`${label} action.${key} is not allowed.`);
  }
  if (action.on !== undefined) {
    if (!isObject(action.on) || typeof action.on.on !== 'boolean') {
      die(`${label} action.on.on must be boolean.`);
    }
  }
  if (action.dimming !== undefined) {
    if (
      !isObject(action.dimming) ||
      typeof action.dimming.brightness !== 'number' ||
      action.dimming.brightness < 0 ||
      action.dimming.brightness > 100
    ) {
      die(`${label} action.dimming.brightness must be 0..100.`);
    }
  }
  if (action.color !== undefined) {
    const xy = action.color?.xy;
    if (
      !isObject(action.color) ||
      !isObject(xy) ||
      typeof xy.x !== 'number' ||
      typeof xy.y !== 'number' ||
      xy.x < 0 ||
      xy.x > 1 ||
      xy.y < 0 ||
      xy.y > 1
    ) {
      die(`${label} action.color.xy must contain x/y values between 0 and 1.`);
    }
  }
  if (action.color_temperature !== undefined) {
    const mirek = action.color_temperature?.mirek;
    if (
      !isObject(action.color_temperature) ||
      !Number.isSafeInteger(mirek) ||
      mirek < 153 ||
      mirek > 500
    ) {
      die(`${label} action.color_temperature.mirek must be 153..500.`);
    }
  }
}

function parseSceneActions(value) {
  const actions = parseJsonArray(value, '--actions-json');
  if (actions.length === 0)
    die('--actions-json must include at least one action.');
  for (const [index, entry] of actions.entries()) {
    const label = `--actions-json[${index}]`;
    if (!isObject(entry)) die(`${label} must be a JSON object.`);
    if (
      !isObject(entry.target) ||
      typeof entry.target.rid !== 'string' ||
      entry.target.rtype !== 'light'
    ) {
      die(`${label}.target must reference a light rid/rtype.`);
    }
    validateHueActionBody(entry.action, label);
  }
  return actions;
}

function parseDurationMs(value, label = '--duration') {
  const raw = requireText(value, label);
  const match = raw.match(/^(\d+)(ms|s|m)?$/u);
  if (!match) die(`${label} must look like 5000ms, 30s, or 1m.`);
  const amount = Number(match[1]);
  const unit = match[2] || 'ms';
  const ms =
    unit === 'm' ? amount * 60_000 : unit === 's' ? amount * 1_000 : amount;
  if (!Number.isSafeInteger(ms) || ms < 1_000 || ms > 120_000) {
    die(`${label} must be between 1s and 120s.`);
  }
  return ms;
}

function parseXy(value) {
  const raw = requireText(value, '--xy');
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    die('--xy must use x,y numeric coordinates.');
  }
  const [x, y] = parts;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    die('--xy values must be between 0 and 1.');
  }
  return { x, y };
}

function parseSecretTemplate(value, label) {
  const match = SECRET_TEMPLATE_RE.exec(value);
  if (!match) {
    die(`${label} secret template must be exactly <secret:NAME>.`);
  }
  return match[1];
}

function isSecretTemplate(value) {
  return SECRET_TEMPLATE_RE.test(value);
}

function isEnvTemplate(value) {
  return ENV_TEMPLATE_RE.test(value);
}

function normalizeBaseUrl(value, label, options = {}) {
  const raw = requireText(value, label);
  if (raw.includes('<secret:')) {
    die(`${label} URL placeholder must use <env:NAME>.`);
  }
  if (raw.includes('<env:')) {
    const normalized = raw.replace(/\/+$/u, '');
    if (!ENV_TEMPLATE_RE.test(normalized)) {
      die(`${label} env placeholder must be exactly <env:NAME>.`);
    }
    return normalized;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    die(`${label} must be a valid URL such as https://192.0.2.30.`);
  }
  if (options.requireHttps && parsed.protocol !== 'https:') {
    die(`${label} must use https.`);
  }
  if (parsed.username || parsed.password) {
    die(`${label} must not contain credentials.`);
  }
  if (parsed.search || parsed.hash) {
    die(`${label} must not contain query strings or fragments.`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed.toString().replace(/\/+$/u, '');
}

function resolveBridgeBase(args) {
  return normalizeBaseUrl(
    popFlag(args, '--host') || `<env:${LOCAL_HOST_ENV}>`,
    '--host',
    { requireHttps: true },
  );
}

function appendPath(base, path) {
  if (isEnvTemplate(base)) return `${base}${path}`;
  const parsed = new URL(base);
  parsed.pathname = `${parsed.pathname}${path}`.replace(/\/{2,}/gu, '/');
  return parsed.toString();
}

function clipUrl(base, resource, id) {
  const suffix = id ? `/${encodeURIComponent(id)}` : '';
  return appendPath(base, `/clip/v2/resource/${resource}${suffix}`);
}

function remoteClipUrl(base, resource, id, bridgeId) {
  const suffix = id ? `/${encodeURIComponent(id)}` : '';
  const bridgeQueryValue = bridgeId.includes('<secret:')
    ? `<secret:${parseSecretTemplate(bridgeId, '--bridge')}>`
    : encodeURIComponent(bridgeId);
  return `${appendPath(base, `/route/clip/v2/resource/${resource}${suffix}`)}?bridge_id=${bridgeQueryValue}`;
}

function buildHttpPayload(operation, tier, options) {
  const httpRequest = {
    url: options.url,
    method: options.method || 'GET',
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes || 1_000_000,
    skillName: 'hue',
    stakesTier: tier,
  };
  if (options.headers) httpRequest.headers = options.headers;
  if (options.body !== undefined) httpRequest.body = options.body;
  if (options.form !== undefined) httpRequest.form = options.form;
  if (options.json !== undefined) httpRequest.json = options.json;
  if (options.secretHeaders) httpRequest.secretHeaders = options.secretHeaders;
  if (options.replaceSecretPlaceholders !== undefined) {
    httpRequest.replaceSecretPlaceholders = options.replaceSecretPlaceholders;
  }
  if (options.captureResponseFields) {
    httpRequest.captureResponseFields = options.captureResponseFields;
  }
  if (options.tls?.allowSelfSigned) {
    httpRequest.allowSelfSignedTls = true;
  }

  const payload = {
    command: 'http-request',
    operation,
    stakesTier: tier,
    httpRequest,
    costMeasurement: COST_MEASUREMENT,
  };
  if (options.target) payload.target = options.target;
  if (options.secretRefPolicy)
    payload.secretRefPolicy = options.secretRefPolicy;
  if (options.liveExecution) payload.liveExecution = options.liveExecution;
  if (options.tls) payload.tls = publicTlsPolicy(options.tls);
  return payload;
}

function publicTlsPolicy(tls) {
  return {
    selfSignedBridgeCertificateExpected:
      tls.selfSignedBridgeCertificateExpected,
    allowSelfSignedTls: Boolean(tls.allowSelfSigned),
  };
}

function localSecretHeaders() {
  return [
    {
      name: 'hue-application-key',
      secretName: LOCAL_KEY_SECRET,
      prefix: 'none',
    },
  ];
}

function localTlsPolicy() {
  return {
    selfSignedBridgeCertificateExpected: true,
    allowSelfSigned: true,
  };
}

function buildLocalRead(args, resourceAlias) {
  const base = resolveBridgeBase(args);
  const tls = localTlsPolicy();
  const durationMs =
    resourceAlias === 'eventstream'
      ? parseDurationMs(popFlag(args, '--duration', '30s'))
      : undefined;
  assertNoUnexpectedArgs(args);

  if (resourceAlias === 'eventstream') {
    return buildHttpPayload('local-eventstream', 'green', {
      url: appendPath(base, '/eventstream/clip/v2'),
      timeoutMs: durationMs,
      maxResponseBytes: 2_000_000,
      headers: {
        Accept: 'text/event-stream',
      },
      secretHeaders: localSecretHeaders(),
      replaceSecretPlaceholders: true,
      tls,
      target: { resource: 'eventstream' },
      secretRefPolicy: LOCAL_EVENTSTREAM_SECRET_REF_POLICY,
    });
  }

  const resource = CLIP_V2_RESOURCES[resourceAlias];
  if (!resource) die(`Unsupported Hue read resource: ${resourceAlias}`);
  return buildHttpPayload(
    `local-${resource.replace(/_/gu, '-')}-list`,
    'green',
    {
      url: clipUrl(base, resource),
      secretHeaders: localSecretHeaders(),
      replaceSecretPlaceholders: true,
      tls,
      target: { resource },
      secretRefPolicy: LOCAL_SECRET_REF_POLICY,
    },
  );
}

function remoteBase(args) {
  return normalizeBaseUrl(
    popFlag(args, '--remote-host') || 'https://api.meethue.com',
    '--remote-host',
    { requireHttps: true },
  );
}

function remoteBearerHeaders() {
  return [
    {
      name: 'Authorization',
      secretName: REMOTE_ACCESS_TOKEN_SECRET,
      prefix: 'Bearer',
    },
  ];
}

function remoteBridgeLiveExecution(bridgeId) {
  return {
    requiresConfiguredSecrets: bridgeId.includes('<secret:')
      ? REMOTE_BRIDGE_SECRETS
      : [REMOTE_ACCESS_TOKEN_SECRET],
  };
}

function buildRemoteRead(args, resourceAlias) {
  const base = remoteBase(args);
  if (resourceAlias === 'remote-oauth-token') {
    assertNoUnexpectedArgs(args);
    return buildHttpPayload('remote-oauth-token', 'amber', {
      url: appendPath(base, '/v2/oauth2/token'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      form: {
        grant_type: 'refresh_token',
        refresh_token: `<secret:${REMOTE_REFRESH_TOKEN_SECRET}>`,
        client_id: `<secret:${REMOTE_CLIENT_ID_SECRET}>`,
        client_secret: `<secret:${REMOTE_CLIENT_SECRET_SECRET}>`,
      },
      replaceSecretPlaceholders: true,
      captureResponseFields: [
        { jsonPath: 'access_token', secretName: REMOTE_ACCESS_TOKEN_SECRET },
        { jsonPath: 'refresh_token', secretName: REMOTE_REFRESH_TOKEN_SECRET },
      ],
      target: { resource: 'remote-oauth-token' },
      secretRefPolicy:
        'Hue Remote OAuth secrets are emitted only as body placeholders. The gateway captures access_token and refresh_token into runtime secrets without returning token values.',
      liveExecution: {
        requiresConfiguredSecrets: [
          REMOTE_CLIENT_ID_SECRET,
          REMOTE_CLIENT_SECRET_SECRET,
          REMOTE_REFRESH_TOKEN_SECRET,
        ],
        capturesSecrets: [
          REMOTE_ACCESS_TOKEN_SECRET,
          REMOTE_REFRESH_TOKEN_SECRET,
        ],
      },
    });
  }
  if (resourceAlias === 'remote-bridges') {
    assertNoUnexpectedArgs(args);
    return buildHttpPayload('remote-bridges', 'amber', {
      url: appendPath(base, '/route/api/0/config'),
      secretHeaders: remoteBearerHeaders(),
      replaceSecretPlaceholders: true,
      target: { resource: 'remote-bridges' },
      secretRefPolicy:
        'Hue Remote API calls are off-LAN amber operations. The bearer token is emitted only as a secretHeaders reference.',
      liveExecution: {
        requiresConfiguredSecrets: [REMOTE_ACCESS_TOKEN_SECRET],
      },
    });
  }

  if (resourceAlias.startsWith('remote-')) {
    const resource = CLIP_V2_RESOURCES[resourceAlias.slice('remote-'.length)];
    if (!resource)
      die(`Unsupported Hue remote read resource: ${resourceAlias}`);
    const bridgeId =
      popFlag(args, '--bridge') || `<secret:${REMOTE_BRIDGE_ID_SECRET}>`;
    assertNoUnexpectedArgs(args);
    return buildHttpPayload(
      `remote-${resource.replace(/_/gu, '-')}-list`,
      'amber',
      {
        url: remoteClipUrl(base, resource, undefined, bridgeId),
        secretHeaders: remoteBearerHeaders(),
        replaceSecretPlaceholders: true,
        target: { resource, bridgeId, remote: true },
        secretRefPolicy: REMOTE_SECRET_REF_POLICY,
        liveExecution: remoteBridgeLiveExecution(bridgeId),
      },
    );
  }
}

function parseOnOffPlan(args, options) {
  const id = requireFlag(args, options.flag);
  return {
    resource: options.resource,
    id,
    json: { on: { on: options.on } },
    target: {
      type: options.targetType,
      id,
      action: options.on ? 'on' : 'off',
    },
  };
}

function parseBrightnessPlan(args, options) {
  const id = requireFlag(args, options.flag);
  const pct = parsePct(popFlag(args, '--pct'));
  return {
    resource: options.resource,
    id,
    json: { dimming: { brightness: pct } },
    target: { type: options.targetType, id, action: 'brightness', pct },
  };
}

function parseColorPlan(args, options) {
  const id = requireFlag(args, options.flag);
  const xy = popFlag(args, '--xy');
  const mirek = popFlag(args, '--mirek');
  if ((xy && mirek) || (!xy && !mirek)) {
    die(`${options.operation} requires exactly one of --xy or --mirek.`);
  }
  if (xy) {
    const parsedXy = parseXy(xy);
    return {
      resource: options.resource,
      id,
      json: { color: { xy: parsedXy } },
      target: {
        type: options.targetType,
        id,
        action: 'color-xy',
        xy: parsedXy,
      },
    };
  }
  const parsedMirek = parseIntegerRange(mirek, '--mirek', 153, 500);
  return {
    resource: options.resource,
    id,
    json: { color_temperature: { mirek: parsedMirek } },
    target: {
      type: options.targetType,
      id,
      action: 'color-temperature',
      mirek: parsedMirek,
    },
  };
}

function parseSceneRecallPlan(args) {
  const id = requireFlag(args, '--scene');
  return {
    resource: 'scene',
    id,
    json: { recall: { action: 'active' } },
    target: { type: 'scene', id, action: 'recall-active' },
  };
}

function parseBehaviorTogglePlan(args, enabled) {
  const id = requireFlag(args, '--behavior');
  return {
    resource: 'behavior_instance',
    id,
    json: { enabled },
    target: {
      type: 'behavior_instance',
      id,
      action: enabled ? 'enable' : 'disable',
    },
  };
}

function parseSceneCreatePlan(args) {
  const name = requireFlag(args, '--name');
  const groupRid = requireFlag(args, '--group');
  const groupType = requireFlag(args, '--group-type', 'room');
  if (!['room', 'zone', 'bridge_home'].includes(groupType)) {
    die('--group-type must be room, zone, or bridge_home.');
  }
  const actions = parseSceneActions(popFlag(args, '--actions-json'));
  const autoDynamic = popFlag(args, '--auto-dynamic');
  const json = {
    type: 'scene',
    actions,
    metadata: { name },
    group: { rid: groupRid, rtype: groupType },
  };
  if (autoDynamic !== undefined) {
    json.auto_dynamic = parseBooleanValue(autoDynamic, '--auto-dynamic');
  }
  return {
    resource: 'scene',
    json,
    target: { type: 'scene', action: 'create', name, groupRid, groupType },
  };
}

function parseBehaviorCreatePlan(args) {
  const name = requireFlag(args, '--name');
  const configuration = parseJsonObject(
    popFlag(args, '--configuration-json'),
    '--configuration-json',
  );
  return {
    resource: 'behavior_instance',
    json: {
      type: 'behavior_instance',
      metadata: { name },
      enabled: parseBooleanValue(
        popFlag(args, '--enabled', 'true'),
        '--enabled',
      ),
      configuration,
    },
    target: { type: 'behavior_instance', action: 'create', name },
  };
}

function parseBridgeTimezonePlan(args) {
  const id = requireFlag(args, '--bridge');
  const timezone = requireFlag(args, '--timezone');
  return {
    resource: 'bridge',
    id,
    json: { time_zone: { time_zone: timezone } },
    target: { type: 'bridge', id, action: 'set-timezone', timezone },
  };
}

function parseBridgeSoftwareUpdatePlan(args) {
  const id = requireFlag(args, '--bridge');
  const enabled = parseBooleanValue(popFlag(args, '--enabled'), '--enabled');
  return {
    resource: 'bridge',
    id,
    json: { software_update: { auto_update: { on: enabled } } },
    target: {
      type: 'bridge',
      id,
      action: 'set-software-update-auto',
      enabled,
    },
  };
}

const PLAN_BUILDERS = {
  'light-on': (args) =>
    parseOnOffPlan(args, {
      resource: 'light',
      targetType: 'light',
      flag: '--light',
      on: true,
    }),
  'light-off': (args) =>
    parseOnOffPlan(args, {
      resource: 'light',
      targetType: 'light',
      flag: '--light',
      on: false,
    }),
  'light-brightness': (args) =>
    parseBrightnessPlan(args, {
      resource: 'light',
      targetType: 'light',
      flag: '--light',
    }),
  'light-color': (args, operation) =>
    parseColorPlan(args, {
      resource: 'light',
      targetType: 'light',
      flag: '--light',
      operation,
    }),
  'group-on': (args) =>
    parseOnOffPlan(args, {
      resource: 'grouped_light',
      targetType: 'grouped_light',
      flag: '--group',
      on: true,
    }),
  'group-off': (args) =>
    parseOnOffPlan(args, {
      resource: 'grouped_light',
      targetType: 'grouped_light',
      flag: '--group',
      on: false,
    }),
  'group-brightness': (args) =>
    parseBrightnessPlan(args, {
      resource: 'grouped_light',
      targetType: 'grouped_light',
      flag: '--group',
    }),
  'group-color': (args, operation) =>
    parseColorPlan(args, {
      resource: 'grouped_light',
      targetType: 'grouped_light',
      flag: '--group',
      operation,
    }),
  'room-on': (args) =>
    parseOnOffPlan(args, {
      resource: 'grouped_light',
      targetType: 'grouped_light',
      flag: '--room',
      on: true,
    }),
  'room-off': (args) =>
    parseOnOffPlan(args, {
      resource: 'grouped_light',
      targetType: 'grouped_light',
      flag: '--room',
      on: false,
    }),
  'group-recall-scene': parseSceneRecallPlan,
  'scene-recall': parseSceneRecallPlan,
  'behavior-enable': (args) => parseBehaviorTogglePlan(args, true),
  'behavior-disable': (args) => parseBehaviorTogglePlan(args, false),
  'scene-create': parseSceneCreatePlan,
  'behavior-create': parseBehaviorCreatePlan,
  'bridge-config-timezone': parseBridgeTimezonePlan,
  'bridge-config-software-update': parseBridgeSoftwareUpdatePlan,
};

function stripFlagWithValue(args, flag) {
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      index += 1;
      continue;
    }
    stripped.push(args[index]);
  }
  return stripped;
}

function parsePlanBody(operation, args) {
  const planBuilder = PLAN_BUILDERS[operation];
  if (!planBuilder) die(`Unsupported Hue plan operation: ${operation}`);
  const originalArgs = [...args];
  const remote = popBoolean(args, '--remote');
  const remoteBridgeId = remote
    ? popFlag(args, '--remote-bridge') || `<secret:${REMOTE_BRIDGE_ID_SECRET}>`
    : undefined;
  const bridgeConfig = operation.startsWith('bridge-config-');
  const tier = bridgeConfig ? 'red' : 'amber';
  const grant = bridgeConfig ? BRIDGE_CONFIG_GRANT : WRITE_GRANT;
  const base = remote ? remoteBase(args) : resolveBridgeBase(args);
  const tls = remote ? undefined : localTlsPolicy();
  const { resource, id, json, target } = planBuilder(args, operation);

  const operatorGrant = popFlag(args, '--operator-grant');
  assertNoUnexpectedArgs(args);

  const httpPayload = buildHttpPayload(
    `${remote ? 'remote' : 'local'}-${operation}`,
    tier,
    {
      url: remote
        ? remoteClipUrl(base, resource, id, remoteBridgeId)
        : clipUrl(base, resource, id),
      method: id ? 'PUT' : 'POST',
      json,
      secretHeaders: remote ? remoteBearerHeaders() : localSecretHeaders(),
      replaceSecretPlaceholders: true,
      tls,
      target: {
        ...target,
        ...(remote ? { remote: true, bridgeId: remoteBridgeId } : {}),
      },
      secretRefPolicy: remote
        ? REMOTE_MUTATION_SECRET_REF_POLICY
        : LOCAL_MUTATION_SECRET_REF_POLICY,
      liveExecution: remote
        ? remoteBridgeLiveExecution(remoteBridgeId)
        : undefined,
    },
  );
  httpPayload.requiredGrant = grant;

  if (operatorGrant) {
    if (operatorGrant !== grant) {
      die(`--operator-grant must be ${grant} for ${operation}.`);
    }
    return httpPayload;
  }

  const approvedArgs = [
    'plan',
    operation,
    ...stripFlagWithValue(originalArgs, '--operator-grant'),
    '--operator-grant',
    grant,
  ];
  const approvedCommand = [
    'node',
    'skills/hue/hue.cjs',
    '--format',
    'json',
    ...approvedArgs,
  ];
  return {
    command: 'approval-plan',
    operation,
    stakesTier: tier,
    requiredGrant: grant,
    target,
    requestPreview: {
      method: httpPayload.httpRequest.method,
      url: httpPayload.httpRequest.url,
      json,
    },
    approvedHelperCommand: approvedCommand,
    approvedHelperCommandText: approvedCommand.map(shellQuote).join(' '),
    approvalRequired: true,
    approvalText: `Approve Hue ${operation}: target ${target.type || 'resource'} ${target.id || '(unknown)'}, action ${target.action || operation}, grant ${grant}.`,
    approvalBoundary:
      'Stop after producing this plan. Do not run approvedHelperCommandText until the operator confirms in a later message.',
    costMeasurement: COST_MEASUREMENT,
  };
}

function buildLinkRequest(args) {
  const host = normalizeBaseUrl(popFlag(args, '--host'), '--host', {
    requireHttps: true,
  });
  const appName = requireText(
    popFlag(args, '--app-name', 'hybridclaw'),
    '--app-name',
  );
  const instanceName = requireText(
    popFlag(args, '--instance-name', 'default'),
    '--instance-name',
  );
  const tls = localTlsPolicy();
  assertNoUnexpectedArgs(args);
  return buildHttpPayload('local-link-button', 'amber', {
    url: appendPath(host, '/api'),
    method: 'POST',
    json: {
      devicetype: `${appName}#${instanceName}`,
      generateclientkey: true,
    },
    timeoutMs: 5_000,
    maxResponseBytes: 50_000,
    replaceSecretPlaceholders: true,
    tls,
    target: { resource: 'link-button', host },
    secretRefPolicy:
      'The link response contains a fresh application key. Live link mode stores it as HUE_APPLICATION_KEY and redacts it from output.',
    liveExecution: {
      mode: 'hue-link-button-poll',
      pollsForMs: 30_000,
      capturesSecrets: [LOCAL_KEY_SECRET],
      operatorProcedure:
        'Press the Hue Bridge link button, then run this command once from an operator-owned terminal.',
    },
  });
}

function buildRequest(inputArgs) {
  const args = [...inputArgs];
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return undefined;
  }
  popFlag(args, '--format', 'pretty');
  popBoolean(args, '--request');
  const command = args.shift();
  if (!command) die('Command is required. Use --help for usage.');

  if (command === 'http-request') {
    const resource = requireText(args.shift(), 'resource');
    const isRemoteClipRead =
      resource.startsWith('remote-') &&
      Boolean(CLIP_V2_RESOURCES[resource.slice('remote-'.length)]);
    if (!READ_ALIASES.has(resource) && !isRemoteClipRead) {
      die(`Unsupported Hue read resource: ${resource}`);
    }
    return resource.startsWith('remote-')
      ? buildRemoteRead(args, resource)
      : buildLocalRead(args, resource);
  }

  if (command === 'plan') {
    const operation = requireText(args.shift(), 'operation');
    return parsePlanBody(operation, args);
  }

  if (command === 'link') {
    return buildLinkRequest(args);
  }

  die(`Unsupported Hue command: ${command}`);
}

function parseGatewayEnvelope(text) {
  let parsed;
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    return {
      ok: false,
      status: 0,
      bodyText: text,
    };
  }
  if (typeof parsed.body === 'string') {
    try {
      parsed.bodyJson = JSON.parse(parsed.body);
    } catch {
      parsed.bodyText = parsed.body;
    }
  }
  return parsed;
}

async function executeGatewayRequest(httpRequest, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this Node.js runtime.');
  }
  const gatewayUrl = (
    options.gatewayUrl ||
    process.env.HYBRIDCLAW_GATEWAY_URL ||
    DEFAULT_GATEWAY_URL
  ).replace(/\/+$/u, '');
  const headers = {
    'Content-Type': 'application/json',
  };
  const token = options.gatewayToken || process.env.HYBRIDCLAW_GATEWAY_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(`${gatewayUrl}/api/http/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify(httpRequest),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Gateway proxy request failed before Hue request was sent: ${message}. Check that the HybridClaw gateway is running and reachable at ${gatewayUrl}.`,
    );
  }
  const text = await response.text();
  const envelope = parseGatewayEnvelope(text);
  return {
    command: 'live-result',
    ok: response.ok && envelope.ok !== false,
    gatewayStatus: response.status,
    status: envelope.status ?? response.status,
    bodyJson: envelope.bodyJson,
    bodyText: envelope.bodyText,
    captured: envelope.captured,
  };
}

async function storeHueSecret(secretName, value) {
  const moduleUrl = pathToFileURL(
    path.resolve(
      __dirname,
      '..',
      '..',
      'dist',
      'security',
      'runtime-secrets.js',
    ),
  ).href;
  let runtimeSecrets;
  try {
    runtimeSecrets = await import(moduleUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Hue link succeeded, but the runtime secret store module was not available to persist ${secretName}: ${message}. Run from a built HybridClaw checkout or store ${secretName} manually with /secret set.`,
    );
  }
  runtimeSecrets.saveNamedRuntimeSecrets({ [secretName]: value });
}

function isHueUnauthorizedResult(result) {
  if (!result) return false;
  if (result.status === 401 || result.gatewayStatus === 401) return true;
  const body = result.bodyJson;
  if (Array.isArray(body)) {
    return body.some((entry) => {
      const error =
        entry && typeof entry === 'object' ? entry.error : undefined;
      return (
        error &&
        typeof error === 'object' &&
        String(error.type || '').toLowerCase() === 'unauthorized_user'
      );
    });
  }
  if (body && typeof body === 'object' && Array.isArray(body.errors)) {
    return body.errors.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const type = String(entry.type || entry.error_type || '').toLowerCase();
      const description = String(entry.description || '').toLowerCase();
      return (
        type === 'unauthorized_user' || description.includes('unauthorized')
      );
    });
  }
  return false;
}

function hueUnauthorizedEvent(operation) {
  return {
    event: 'hue.bridge_relink_required',
    operation,
    message:
      'Hue Bridge rejected the stored application key. Stop after this failed call and re-link the bridge with the link-button flow.',
  };
}

function extractHueLinkUsername(bodyJson) {
  if (!Array.isArray(bodyJson)) return undefined;
  for (const entry of bodyJson) {
    if (!entry || typeof entry !== 'object') continue;
    const username = entry.success?.username;
    if (typeof username === 'string' && username.trim()) {
      return username.trim();
    }
  }
  return undefined;
}

function isTerminalHueLinkResult(result) {
  if (!result) return false;
  const status = Number(result.status || result.gatewayStatus || 0);
  if (status === 404 || status >= 500) return true;
  const body = result.bodyJson;
  if (!Array.isArray(body)) return false;
  return body.some((entry) => {
    const error = entry && typeof entry === 'object' ? entry.error : undefined;
    if (!error || typeof error !== 'object') return false;
    const type = String(error.type || '').toLowerCase();
    return Boolean(
      type && type !== 'link_button_not_pressed' && type !== '101',
    );
  });
}

async function executeLivePayload(payload, options = {}) {
  if (!payload.httpRequest) return payload;
  if (payload.operation === 'local-link-button') {
    const deadline = Date.now() + 30_000;
    let lastResult;
    while (Date.now() <= deadline) {
      lastResult = await executeGatewayRequest(payload.httpRequest, options);
      const username = extractHueLinkUsername(lastResult.bodyJson);
      if (username) {
        const storeSecret =
          typeof options.storeSecret === 'function'
            ? options.storeSecret
            : storeHueSecret;
        await storeSecret(LOCAL_KEY_SECRET, username);
        return {
          command: 'live-link-result',
          ok: true,
          operation: payload.operation,
          captured: {
            username: LOCAL_KEY_SECRET,
          },
          secretStored: true,
          request: {
            url: payload.httpRequest.url,
            method: payload.httpRequest.method,
          },
        };
      }
      if (isTerminalHueLinkResult(lastResult)) {
        return {
          command: 'live-link-result',
          ok: false,
          operation: payload.operation,
          event: 'hue.link_button_failed',
          message:
            'Hue Bridge returned a terminal error during link-button polling. Check the bridge host and gateway proxy result before retrying.',
          lastResult,
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, options.pollDelayMs || 2_000),
      );
    }
    return {
      command: 'live-link-result',
      ok: false,
      operation: payload.operation,
      event: 'hue.link_button_timeout',
      message:
        'Hue Bridge did not return an application key within 30s. Press the bridge link button and retry.',
      lastResult,
    };
  }

  const result = await executeGatewayRequest(payload.httpRequest, options);
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
  if (isHueUnauthorizedResult(result)) {
    output.stopAfterFirstFailedCall = true;
    output.event = hueUnauthorizedEvent(payload.operation);
  }
  return output;
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
  if (payload === undefined) return;
  const output =
    !emitRequestOnly && payload.httpRequest
      ? await executeLivePayload(payload)
      : payload;
  process.stdout.write(
    JSON.stringify(output, null, format === 'pretty' ? 2 : 0),
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
  extractHueLinkUsername,
  isHueUnauthorizedResult,
};
