#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const net = require('node:net');

const SKILL_NAME = 'homematic';
const DEFAULT_PLUGIN_ID = 'com.hybridaione.hybridclaw.homematic';
const AUTH_TOKEN_SECRET = 'HOMEMATIC_HCU_AUTH_TOKEN';
const ACTIVATION_KEY_SECRET = 'HOMEMATIC_HCU_ACTIVATION_KEY';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 200_000;
const DEFAULT_WEBSOCKET_TIMEOUT_MS = 10_000;
const DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES = 200_000;
const WRITE_GRANT = 'approve-homematic-write';
const SECURITY_WRITE_GRANT = 'approve-homematic-security-write';

const SECRET_FLAGS = new Set([
  '--activation-key',
  '--auth-token',
  '--authorization',
  '--authorization-header',
  '--authtoken',
  '--bearer',
  '--client-secret',
  '--password',
  '--pin',
  '--security-code',
  '--token',
  '--user',
  '--username',
]);

const HTTP_COMMANDS = new Set(['auth-token', 'confirm-token']);
const WEBSOCKET_COMMANDS = new Set([
  'plugin-ready',
  'get-state',
  'get-system-state',
  'set-switch-state',
  'set-set-point-temperature',
  'set-shutter-level',
  'start-light-scene',
  'acknowledge-safety-alarm',
]);

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload, format = 'pretty') {
  const indent = format === 'pretty' ? 2 : undefined;
  process.stdout.write(`${JSON.stringify(payload, null, indent)}\n`);
}

function usage() {
  return `Homematic skill helper

Usage:
  node skills/homematic/homematic.cjs --format json plan get-state
  node skills/homematic/homematic.cjs --format json approval-plan set-switch-state --hcu-url https://hcu1-1234.local --device-id ID --channel-index 1 --on true
  node skills/homematic/homematic.cjs --format json http-request auth-token --hcu-url https://hcu1-1234.local
  node skills/homematic/homematic.cjs --format json http-request confirm-token --hcu-url https://hcu1-1234.local
  node skills/homematic/homematic.cjs --format json websocket-message get-state --hcu-url https://hcu1-1234.local
  node skills/homematic/homematic.cjs --format json --hmip-system-events websocket-message get-state --hcu-url https://hcu1-1234.local
  node skills/homematic/homematic.cjs --format json websocket-message set-switch-state --hcu-url https://hcu1-1234.local --device-id ID --channel-index 1 --on true --operator-grant approve-homematic-write
  HOMEMATIC_HCU_AUTH_TOKEN=<token> node skills/homematic/homematic.cjs --format json run-websocket get-state --hcu-url https://hcu1-1234.local
  node skills/homematic/homematic.cjs --format json policy-rules --hcu-url https://hcu1-1234.local --agent main
  node skills/homematic/homematic.cjs --format json summarize-fixture --fixture skills/homematic/fixtures/hcu-state.json

Global options:
  --format json|pretty             json emits compact output; pretty emits indented output. Defaults to pretty.
  --plugin-id ID                   HCU Connect API plugin identifier. Defaults to ${DEFAULT_PLUGIN_ID}.
  --hcu-url URL                    HCU URL such as https://hcu1-1234.local. Can also be HOMEMATIC_HCU_URL.
  --request-id UUID                Optional deterministic message id for tests or trace correlation.
  --friendly-name-en TEXT          English plugin name for HCU auth/plugin-ready messages.
  --friendly-name-de TEXT          German plugin name for HCU auth/plugin-ready messages.
  --hmip-system-events             Subscribe to HCU HMIP_SYSTEM_EVENT push messages on connect.
  --insecure-local-tls             Allow self-signed HCU WebSocket TLS only for local/private hosts.
  --help                           Show this help.

Commands:
  plan OPERATION
  approval-plan set-switch-state|set-set-point-temperature|set-shutter-level|start-light-scene|acknowledge-safety-alarm
  http-request auth-token|confirm-token
  websocket-message plugin-ready|get-state|get-system-state|set-switch-state|set-set-point-temperature|set-shutter-level|start-light-scene|acknowledge-safety-alarm
  run-websocket plugin-ready|get-state|get-system-state
  policy-rules --hcu-url URL [--agent AGENT_ID]
  summarize-fixture --fixture PATH

Secret values are not accepted on the command line. Store HCU secrets with:
  hybridclaw secret set ${ACTIVATION_KEY_SECRET} "<activation-key>"
  hybridclaw secret set ${AUTH_TOKEN_SECRET} "<confirmed-auth-token>"`;
}

function parseGlobalArgs(argv) {
  const opts = {
    format: 'pretty',
    friendlyNameDe: 'HybridClaw Homematic',
    friendlyNameEn: 'HybridClaw Homematic',
    help: false,
    pluginId: DEFAULT_PLUGIN_ID,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--insecure-local-tls') {
      opts.insecureLocalTls = true;
      continue;
    }
    if (arg === '--hmip-system-events') {
      opts.hmipSystemEvents = true;
      continue;
    }
    rejectSecretFlag(arg);
    if (
      [
        '--format',
        '--friendly-name-de',
        '--friendly-name-en',
        '--hcu-url',
        '--plugin-id',
        '--request-id',
      ].includes(arg)
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--') || !String(value).trim()) {
        fail(`${arg} requires a value.`);
      }
      if (arg === '--format' && !['json', 'pretty'].includes(value)) {
        fail('--format must be json or pretty.');
      }
      opts[toCamel(arg.slice(2))] = value;
      index += 1;
      continue;
    }
    positional.push(arg);
  }

  return { opts, positional };
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function normalizeText(value) {
  return String(value || '').trim();
}

function requireText(value, label) {
  const text = normalizeText(value);
  if (!text) {
    fail(`${label} is required.`);
  }
  return text;
}

function requireIdentifier(value, label) {
  const text = requireText(value, label);
  if (!/^[A-Za-z0-9_.:-]+$/.test(text)) {
    fail(`${label} may contain only letters, numbers, underscore, dot, colon, and dash.`);
  }
  return text;
}

function parseBoolean(value, label) {
  const text = normalizeText(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  fail(`${label} must be true or false.`);
}

function parseInteger(value, label, min, max) {
  const text = normalizeText(value);
  if (!/^\d+$/.test(text)) {
    fail(`${label} must be an integer between ${min} and ${max}.`);
  }
  const number = Number.parseInt(text, 10);
  if (number < min || number > max) {
    fail(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function parseNumber(value, label, min, max) {
  const text = normalizeText(value);
  if (!/^(?:\d+|\d+\.\d+)$/.test(text)) {
    fail(`${label} must be a number between ${min} and ${max}.`);
  }
  const number = Number.parseFloat(text);
  if (number < min || number > max) {
    fail(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function parseCommandOptions(args, spec = {}) {
  const values = new Set(spec.values || []);
  const result = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    rejectSecretFlag(arg);
    if (values.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--') || !String(value).trim()) {
        fail(`${arg} requires a value.`);
      }
      result[toCamel(arg.slice(2))] = value;
      index += 1;
      continue;
    }
    fail(`Unknown option or argument: ${arg}`);
  }

  return result;
}

function rejectSecretFlag(arg) {
  if (SECRET_FLAGS.has(arg)) {
    fail(`${arg} is not supported. Store Homematic credentials in HybridClaw secrets.`);
  }
}

function hcuUrlFromOptions(opts) {
  return opts.hcuUrl || process.env.HOMEMATIC_HCU_URL || '';
}

function parseHcuUrl(rawUrl, config) {
  const text = requireText(rawUrl, '--hcu-url');
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('--hcu-url must be a valid URL.');
  }
  if (!config.allowedProtocols.includes(url.protocol)) fail(config.protocolError);
  validateHcuUrl(url);
  url.protocol = config.targetProtocol;
  url.port ||= config.defaultPort;
  url.pathname = config.pathname;
  return url;
}

function normalizeHcuHttpBase(rawUrl) {
  const url = parseHcuUrl(rawUrl, {
    allowedProtocols: ['https:'],
    protocolError: '--hcu-url must use https for HCU auth endpoints.',
    targetProtocol: 'https:',
    defaultPort: '6969',
    pathname: '',
  });
  return url.toString().replace(/\/$/, '');
}

function normalizeHcuWebSocketUrl(rawUrl) {
  const url = parseHcuUrl(rawUrl, {
    allowedProtocols: ['https:', 'wss:'],
    protocolError: '--hcu-url must use https or wss for HCU WebSocket messages.',
    targetProtocol: 'wss:',
    defaultPort: '9001',
    pathname: '/',
  });
  return url.toString();
}

function validateHcuUrl(url) {
  if (url.username || url.password) {
    fail('--hcu-url must not include credentials.');
  }
  if (url.search || url.hash) {
    fail('--hcu-url must not include a query string or fragment.');
  }
}

function basePayload(command, operation, stakesTier, options = {}) {
  const payload = {
    command,
    operation,
    skillName: SKILL_NAME,
    stakesTier,
  };
  if (options.measuresUsage) {
    payload.costMeasurement = {
      system: 'UsageTotals',
      subLimitKey: SKILL_NAME,
    };
  }
  return payload;
}

function plannedAuditEventType(stakesTier) {
  return stakesTier === 'green'
    ? 'homematic.state_read_planned'
    : 'homematic.control_planned';
}

function completedAuditEventType(stakesTier) {
  return stakesTier === 'green'
    ? 'homematic.state_read_completed'
    : 'homematic.control_completed';
}

function auditEventsForPlan(operation, stakesTier, messagePath) {
  return [
    {
      type: plannedAuditEventType(stakesTier),
      skill: SKILL_NAME,
      operation,
      stakesTier,
      ...(messagePath ? { path: messagePath } : {}),
      secretRefs: [AUTH_TOKEN_SECRET],
    },
  ];
}

function auditEventsForResult(operation, stakesTier, response) {
  return [
    {
      type: completedAuditEventType(stakesTier),
      skill: SKILL_NAME,
      operation,
      stakesTier,
      responseType: response && response.type,
      responseId: response && response.id,
      hasError: Boolean(response && response.error),
    },
  ];
}

function buildHttpRequest(operation, args, opts) {
  if (!HTTP_COMMANDS.has(operation)) {
    fail(`Unknown http-request operation: ${operation}`);
  }
  parseCommandOptions(args, { values: [] });
  const baseUrl = normalizeHcuHttpBase(hcuUrlFromOptions(opts));
  const common = {
    method: 'POST',
    headers: {
      VERSION: '12',
    },
    replaceSecretPlaceholders: true,
    skillName: SKILL_NAME,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    stakesTier: 'amber',
  };
  const pluginId = requireIdentifier(opts.pluginId, '--plugin-id');

  if (operation === 'auth-token') {
    return {
      ...basePayload('http-request', operation, 'amber', { measuresUsage: true }),
      httpRequest: {
        ...common,
        url: `${baseUrl}/hmip/auth/requestConnectApiAuthToken`,
        json: {
          activationKey: `<secret:${ACTIVATION_KEY_SECRET}>`,
          pluginId,
          friendlyName: {
            en: opts.friendlyNameEn,
            de: opts.friendlyNameDe,
          },
        },
      },
      liveExecution: authLiveExecution([ACTIVATION_KEY_SECRET]),
    };
  }

  return {
    ...basePayload('http-request', operation, 'amber', { measuresUsage: true }),
    httpRequest: {
      ...common,
      url: `${baseUrl}/hmip/auth/confirmConnectApiAuthToken`,
      json: {
        activationKey: `<secret:${ACTIVATION_KEY_SECRET}>`,
        authToken: `<secret:${AUTH_TOKEN_SECRET}>`,
      },
    },
    liveExecution: authLiveExecution([ACTIVATION_KEY_SECRET, AUTH_TOKEN_SECRET]),
  };
}

function authLiveExecution(requiredSecrets) {
  return {
    transport: 'gateway-http-request',
    requiresConfiguredSecrets: requiredSecrets,
    secretRefPolicy: 'Use strict <secret:NAME> placeholders; never print activation keys or auth tokens.',
    unauthorizedPolicy: 'Stop after the first 401/403 or HCU auth error.',
  };
}

function buildWebSocketMessage(operation, args, opts) {
  if (!WEBSOCKET_COMMANDS.has(operation)) {
    fail(`Unknown websocket-message operation: ${operation}`);
  }
  const specs = {
    'plugin-ready': { values: [] },
    'get-state': { values: [] },
    'get-system-state': { values: [] },
    'set-switch-state': {
      values: ['--device-id', '--channel-index', '--on', '--operator-grant'],
    },
    'set-set-point-temperature': {
      values: ['--group-id', '--temperature', '--operator-grant'],
    },
    'set-shutter-level': {
      values: ['--device-id', '--channel-index', '--level', '--operator-grant'],
    },
    'start-light-scene': {
      values: ['--group-id', '--operator-grant'],
    },
    'acknowledge-safety-alarm': {
      values: ['--operator-grant'],
    },
  };
  const parsed = parseCommandOptions(args, specs[operation]);
  const pluginId = requireIdentifier(opts.pluginId, '--plugin-id');
  const id = opts.requestId || randomUUID();
  const pathAndBody = pathAndBodyForOperation(operation, parsed);
  const stakesTier = operationTier(operation);
  const connectionUrl = normalizeHcuWebSocketUrl(hcuUrlFromOptions(opts));
  const connectionHostname = new URL(connectionUrl).hostname;
  const headers = {
    'plugin-id': pluginId,
    ...(opts.hmipSystemEvents ? { 'hmip-system-events': 'true' } : {}),
  };

  validateOperatorGrant(operation, stakesTier, parsed.operatorGrant);

  const message =
    operation === 'plugin-ready'
      ? {
          pluginId,
          id,
          type: 'PLUGIN_STATE_RESPONSE',
          body: {
            pluginReadinessStatus: 'READY',
            friendlyName: {
              en: opts.friendlyNameEn,
              de: opts.friendlyNameDe,
            },
          },
        }
      : {
          pluginId,
          id,
          type: 'HMIP_SYSTEM_REQUEST',
          body: {
            path: pathAndBody.path,
            body: pathAndBody.body,
          },
        };

  return {
    ...basePayload('websocket-message', operation, stakesTier, { measuresUsage: true }),
    requiredGrant: grantForTier(stakesTier),
    connection: {
      transport: 'websocket',
      protocol: 'homematic-ip-connect-api',
      url: connectionUrl,
      headers,
      secretHeaders: [
        {
          name: 'authtoken',
          secretName: AUTH_TOKEN_SECRET,
          prefix: 'none',
        },
      ],
      tls: {
        selfSignedCertificateExpected: isLocalOrPrivateHost(connectionHostname),
      },
    },
    message,
    audit: {
      event: plannedAuditEventType(stakesTier),
      includeFields: ['operation', 'stakesTier', 'message.type', 'message.body.path'],
      neverInclude: ['authtoken', AUTH_TOKEN_SECRET, ACTIVATION_KEY_SECRET],
    },
    auditEvents: auditEventsForPlan(
      operation,
      stakesTier,
      message.body && message.body.path,
    ),
  };
}

function pathAndBodyForOperation(operation, parsed) {
  switch (operation) {
    case 'plugin-ready':
      return { path: '', body: {} };
    case 'get-state':
      return { path: '/hmip/home/getState', body: {} };
    case 'get-system-state':
      return { path: '/hmip/home/getSystemState', body: {} };
    case 'set-switch-state':
      return {
        path: '/hmip/device/control/setSwitchState',
        body: {
          deviceId: requireIdentifier(parsed.deviceId, '--device-id'),
          channelIndex: parseInteger(parsed.channelIndex, '--channel-index', 0, 64),
          on: parseBoolean(parsed.on, '--on'),
        },
      };
    case 'set-set-point-temperature':
      return {
        path: '/hmip/group/heating/setSetPointTemperature',
        body: {
          groupId: requireIdentifier(parsed.groupId, '--group-id'),
          setPointTemperature: parseNumber(parsed.temperature, '--temperature', 4.5, 30.5),
        },
      };
    case 'set-shutter-level':
      return {
        path: '/hmip/device/control/setShutterLevel',
        body: {
          deviceId: requireIdentifier(parsed.deviceId, '--device-id'),
          channelIndex: parseInteger(parsed.channelIndex, '--channel-index', 0, 64),
          shutterLevel: parseNumber(parsed.level, '--level', 0, 1),
        },
      };
    case 'start-light-scene':
      return {
        path: '/hmip/group/switching/startLightScene',
        body: {
          groupId: requireIdentifier(parsed.groupId, '--group-id'),
        },
      };
    case 'acknowledge-safety-alarm':
      return {
        path: '/hmip/home/security/acknowledgeSafetyAlarm',
        body: {},
      };
    default:
      fail(`Unknown websocket-message operation: ${operation}`);
  }
}

function validateOperatorGrant(operation, stakesTier, value) {
  const requiredGrant = grantForTier(stakesTier);
  if (!requiredGrant) return;
  if (value !== requiredGrant) {
    fail(`${operation} requires --operator-grant ${requiredGrant}.`);
  }
}

function grantForTier(stakesTier) {
  if (stakesTier === 'red') return SECURITY_WRITE_GRANT;
  if (stakesTier === 'amber') return WRITE_GRANT;
  return undefined;
}

function operationTier(operation) {
  if (operation === 'acknowledge-safety-alarm') return 'red';
  if (
    operation.startsWith('set-') ||
    operation === 'start-light-scene' ||
    operation === 'auth-token' ||
    operation === 'confirm-token'
  ) {
    return 'amber';
  }
  if (
    operation === 'plugin-ready' ||
    operation === 'get-state' ||
    operation === 'get-system-state' ||
    operation === 'fixture-summary'
  ) {
    return 'green';
  }
  fail(`Unknown Homematic operation: ${operation}`);
}

function plan(operation) {
  const normalized = requireText(operation, 'plan operation');
  const stakesTier = operationTier(normalized);

  return {
    ...basePayload('plan', normalized, stakesTier),
    requiresEscalation: stakesTier !== 'green',
    requiredGrant: grantForTier(stakesTier),
    guidance:
      stakesTier === 'green'
        ? 'Run the matching read helper command directly.'
        : 'Run approval-plan with exact ids, wait for operator confirmation, then run the exact approved command unchanged.',
  };
}

function approvalPlan(operation, args, opts) {
  const stakesTier = operationTier(operation);
  const requiredGrant = grantForTier(stakesTier);
  if (!requiredGrant) {
    fail(`${operation} is read-only and does not need approval-plan.`);
  }
  const payload = buildWebSocketMessage(operation, [...args, '--operator-grant', requiredGrant], opts);
  const commandArgs = [
    '--format',
    'json',
    'websocket-message',
    operation,
    '--hcu-url',
    payload.connection.url,
    ...args,
    '--operator-grant',
    requiredGrant,
  ];

  return {
    ...basePayload('approval-plan', operation, stakesTier),
    requiredGrant,
    approvedCommand: [
      'node',
      'skills/homematic/homematic.cjs',
      ...commandArgs.map(shellQuote),
    ].join(' '),
    approvalText: [
      `Approve Homematic ${operation}.`,
      `HCU: ${payload.connection.url}`,
      `Path: ${payload.message.body.path}`,
      `Body: ${JSON.stringify(payload.message.body.body)}`,
      `Required grant: ${requiredGrant}`,
    ].join('\n'),
    websocketMessage: payload,
  };
}

function shellQuote(value) {
  const raw = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(raw)) return raw;
  return `'${raw.replace(/'/gu, `'\\''`)}'`;
}

function summarizeFixture(args) {
  const parsed = parseCommandOptions(args, { values: ['--fixture'] });
  const fixturePath = requireText(parsed.fixture, '--fixture');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  } catch (error) {
    fail(`Unable to read fixture JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ...basePayload('summarize-fixture', 'fixture-summary', 'green'),
    summary: summarizeHcuState(state),
  };
}

function summarizeHcuState(state) {
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const groups = Array.isArray(state.groups) ? state.groups : [];
  const byType = {};
  const sensitiveSignals = [];
  const controllable = [];

  for (const device of devices) {
    const type = normalizeText(device.deviceType || 'UNKNOWN');
    byType[type] = (byType[type] || 0) + 1;
    const features = Array.isArray(device.features) ? device.features : [];
    for (const feature of features) {
      const featureType = normalizeText(feature.type);
      if (/alarm|presence|contact|motion|smoke|security/i.test(featureType)) {
        sensitiveSignals.push({
          deviceId: device.deviceId,
          friendlyName: device.friendlyName,
          feature: featureType,
        });
      }
      if (/switchState|setPointTemperature|shutterLevel/i.test(featureType)) {
        controllable.push({
          deviceId: device.deviceId,
          friendlyName: device.friendlyName,
          feature: featureType,
          channelIndex: feature.channelIndex,
        });
      }
    }
  }

  return {
    home: {
      id: state.home && state.home.id,
      label: state.home && state.home.label,
      securityState: state.home && state.home.securityState,
    },
    counts: {
      devices: devices.length,
      groups: groups.length,
      byType,
    },
    controllable,
    sensitiveSignals,
  };
}

function summarizeWebSocketResponse(response) {
  const body = response && response.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Array.isArray(body.devices) || Array.isArray(body.groups) || body.home) {
    return summarizeHcuState(body);
  }
  // Connect API responses and fixtures can wrap state once more under body.body.
  if (body.body && typeof body.body === 'object') {
    return summarizeHcuState(body.body);
  }
  return null;
}

function policyRules(args, opts) {
  const parsed = parseCommandOptions(args, { values: ['--agent'] });
  const httpBase = new URL(normalizeHcuHttpBase(hcuUrlFromOptions(opts)));
  const wsUrl = new URL(normalizeHcuWebSocketUrl(hcuUrlFromOptions(opts)));
  const agent = parsed.agent || '*';

  return {
    ...basePayload('policy-rules', 'hcu-policy', 'green'),
    network: {
      rules: [
        {
          action: 'allow',
          host: httpBase.hostname,
          port: Number(httpBase.port || 6969),
          methods: ['POST'],
          paths: [
            '/hmip/auth/requestConnectApiAuthToken',
            '/hmip/auth/confirmConnectApiAuthToken',
          ],
          agent,
          comment: 'Homematic HCU Connect API auth enrollment',
          managed_by_homematic: true,
        },
        {
          action: 'allow',
          host: wsUrl.hostname,
          port: Number(wsUrl.port || 9001),
          methods: ['GET'],
          paths: ['/*'],
          agent,
          comment: 'Homematic HCU Connect API WebSocket',
          managed_by_homematic: true,
        },
      ],
    },
    secret: {
      rules: [
        {
          id: `allow-homematic-hcu-authtoken-${agent}`,
          managed_by_homematic: true,
          when: {
            predicate: 'secret_resolve_allowed',
            id: AUTH_TOKEN_SECRET,
            source: 'store',
            sink: 'websocket',
            host: wsUrl.hostname,
            selector: 'authtoken',
            agent,
          },
          action: 'allow',
        },
        {
          id: `allow-homematic-hcu-activation-key-${agent}`,
          managed_by_homematic: true,
          when: {
            predicate: 'secret_resolve_allowed',
            id: ACTIVATION_KEY_SECRET,
            source: 'store',
            sink: 'http',
            host: httpBase.hostname,
            selector: 'json.activationKey',
            agent,
          },
          action: 'allow',
        },
      ],
    },
    applyWith: [
      `hybridclaw policy allow ${httpBase.hostname} --port ${httpBase.port || 6969} --methods POST --paths /hmip/auth/requestConnectApiAuthToken,/hmip/auth/confirmConnectApiAuthToken --agent ${agent} --comment "Homematic HCU auth"`,
      `hybridclaw policy allow ${wsUrl.hostname} --port ${wsUrl.port || 9001} --methods GET --paths /* --agent ${agent} --comment "Homematic HCU WebSocket"`,
    ],
  };
}

function readAuthTokenFromEnv(env = process.env) {
  const token = normalizeText(env[AUTH_TOKEN_SECRET]);
  if (!token) {
    throw new Error(`${AUTH_TOKEN_SECRET} must be set in the helper environment for run-websocket.`);
  }
  return token;
}

function loadWebSocketClass() {
  let wsModule;
  try {
    wsModule = require('ws');
  } catch {
    fail("run-websocket requires the 'ws' npm package. Install it or use the gateway transport instead.");
  }
  return wsModule.WebSocket || wsModule.default || wsModule;
}

function isLocalOrPrivateHost(hostname) {
  const host = normalizeText(hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) return true;

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map((part) => Number.parseInt(part, 10));
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (ipVersion === 6) {
    return (
      host === '::1' ||
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd')
    );
  }
  return false;
}

function rawWebSocketByteLength(raw) {
  if (Buffer.isBuffer(raw)) return raw.length;
  return Buffer.byteLength(String(raw), 'utf-8');
}

function rawWebSocketToString(raw) {
  if (Buffer.isBuffer(raw)) return raw.toString('utf-8');
  return String(raw);
}

function executeHcuWebSocketMessage(payload, options = {}) {
  if (payload.stakesTier !== 'green') {
    throw new Error('run-websocket is restricted to green read-only Homematic operations.');
  }
  const WebSocketClass = options.WebSocketClass || loadWebSocketClass();
  const authToken = options.authToken || readAuthTokenFromEnv(options.env);
  const timeoutMs = options.timeoutMs || DEFAULT_WEBSOCKET_TIMEOUT_MS;
  const maxPayloadBytes = options.maxPayloadBytes || DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES;
  const connectionUrl = new URL(payload.connection.url);
  const rejectUnauthorized = !options.insecureLocalTls;
  if (options.insecureLocalTls && !isLocalOrPrivateHost(connectionUrl.hostname)) {
    throw new Error('--insecure-local-tls is only allowed for local/private HCU hosts.');
  }
  const headers = {
    ...payload.connection.headers,
    authtoken: authToken,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (socket && typeof socket.close === 'function') socket.close();
      } catch {
        // Ignore close races.
      }
      reject(new Error(`Homematic HCU WebSocket timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (socket && typeof socket.close === 'function') socket.close();
      } catch {
        // Ignore close races.
      }
      fn(value);
    };

    try {
      socket = new WebSocketClass(payload.connection.url, {
        headers,
        rejectUnauthorized,
        maxPayload: maxPayloadBytes,
      });
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
      return;
    }

    socket.on('open', () => {
      socket.send(JSON.stringify(payload.message));
    });
    socket.on('message', (raw) => {
      const byteLength = rawWebSocketByteLength(raw);
      if (byteLength > maxPayloadBytes) {
        finish(reject, new Error(`Homematic HCU WebSocket response exceeded ${maxPayloadBytes} bytes.`));
        return;
      }
      let response;
      try {
        response = JSON.parse(rawWebSocketToString(raw));
      } catch (error) {
        finish(reject, new Error(`Homematic HCU returned non-JSON WebSocket data: ${error.message}`));
        return;
      }
      if (!response || response.id !== payload.message.id) {
        return;
      }
      const summary = summarizeWebSocketResponse(response);
      finish(resolve, {
        ...basePayload('run-websocket', payload.operation, payload.stakesTier, {
          measuresUsage: true,
        }),
        request: {
          operation: payload.operation,
          message: payload.message,
          connection: {
            ...payload.connection,
            secretHeaders: payload.connection.secretHeaders,
          },
        },
        response,
        ...(summary ? { summary } : {}),
        auditEvents: [
          ...payload.auditEvents,
          ...auditEventsForResult(payload.operation, payload.stakesTier, response),
        ],
      });
    });
    socket.on('error', (error) => {
      finish(reject, error);
    });
    socket.on('close', () => {
      if (settled) return;
      finish(reject, new Error('Homematic HCU WebSocket closed before a response was received.'));
    });
  });
}

function buildRequest(argv) {
  const { opts, positional } = parseGlobalArgs(argv);
  return buildRequestFromParsed(opts, positional);
}

function buildRequestFromParsed(opts, positional) {
  if (opts.help || positional.length === 0) {
    return { help: usage() };
  }

  const command = positional[0];
  if (command === 'plan') {
    return plan(positional[1]);
  }
  if (command === 'approval-plan') {
    const operation = positional[1];
    if (!operation) fail('approval-plan requires an operation.');
    return approvalPlan(operation, positional.slice(2), opts);
  }
  if (command === 'http-request') {
    const operation = positional[1];
    if (!operation) fail('http-request requires an operation.');
    return buildHttpRequest(operation, positional.slice(2), opts);
  }
  if (command === 'websocket-message') {
    const operation = positional[1];
    if (!operation) fail('websocket-message requires an operation.');
    return buildWebSocketMessage(operation, positional.slice(2), opts);
  }
  if (command === 'policy-rules') {
    return policyRules(positional.slice(1), opts);
  }
  if (command === 'summarize-fixture') {
    return summarizeFixture(positional.slice(1));
  }

  fail(`Unknown command: ${command}`);
}

async function main() {
  const { opts, positional } = parseGlobalArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (positional[0] === 'run-websocket') {
    const operation = positional[1];
    if (!operation) fail('run-websocket requires an operation.');
    const payload = buildWebSocketMessage(operation, positional.slice(2), opts);
    const result = await executeHcuWebSocketMessage(payload, {
      insecureLocalTls: opts.insecureLocalTls,
    });
    printJson(result, opts.format);
    return;
  }
  const payload = buildRequestFromParsed(opts, positional);
  printJson(payload, opts.format);
}

if (require.main === module) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error), 1));
}

module.exports = {
  ACTIVATION_KEY_SECRET,
  AUTH_TOKEN_SECRET,
  buildRequest,
  executeHcuWebSocketMessage,
  normalizeHcuHttpBase,
  normalizeHcuWebSocketUrl,
  summarizeHcuState,
  summarizeWebSocketResponse,
};
