#!/usr/bin/env node
'use strict';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const GATEWAY_TIMEOUT_BUFFER_MS = 1_000;
const SKILL_NAME = 'fronius';
const LOCAL_HOST_ENV = 'FRONIUS_LOCAL_HOST';
const SOLARWEB_ACCESS_KEY_ID_SECRET = 'FRONIUS_SOLARWEB_ACCESS_KEY_ID';
const SOLARWEB_ACCESS_KEY_VALUE_SECRET = 'FRONIUS_SOLARWEB_ACCESS_KEY_VALUE';
const SOLARWEB_BASE_URL = 'https://api.solarweb.com';

const LOCAL_API_VERSION_OPERATION = {
  path: '/solar_api/GetAPIVersion.cgi',
  maxResponseBytes: 100_000,
};

const LOCAL_OPERATIONS = {
  'local-health': LOCAL_API_VERSION_OPERATION,
  'local-api-version': LOCAL_API_VERSION_OPERATION,
  'local-inverter-info': {
    path: '/solar_api/v1/GetInverterInfo.cgi',
    maxResponseBytes: 500_000,
    responseShape: 'inverter-info',
  },
  'local-inverter-realtime': {
    path: '/solar_api/v1/GetInverterRealtimeData.cgi',
    scoped: true,
    inverterRealtime: true,
    responseShape: 'inverter-realtime',
  },
  'local-power-flow': {
    path: '/solar_api/v1/GetPowerFlowRealtimeData.fcgi',
    responseShape: 'power-flow',
  },
  'local-meter-realtime': {
    path: '/solar_api/v1/GetMeterRealtimeData.cgi',
    scoped: true,
    responseShape: 'meter-realtime',
  },
  'local-storage-realtime': {
    path: '/solar_api/v1/GetStorageRealtimeData.cgi',
    scoped: true,
    responseShape: 'storage-realtime',
  },
  'local-ohmpilot-realtime': {
    path: '/solar_api/v1/GetOhmPilotRealtimeData.cgi',
    scoped: true,
    noDeviceId: true,
  },
  'local-archive': {
    path: '/solar_api/v1/GetArchiveData.cgi',
    archive: true,
    maxResponseBytes: 4_000_000,
    responseShape: 'energy-archive',
  },
  'local-logger-info': {
    path: '/solar_api/v1/GetLoggerInfo.cgi',
    maxResponseBytes: 500_000,
  },
  'local-active-device-info': {
    path: '/solar_api/v1/GetActiveDeviceInfo.cgi',
    activeDeviceInfo: true,
    maxResponseBytes: 500_000,
  },
};

const CLOUD_PVSYSTEMS_OPERATION = {
  path: '/swqapi/pvsystems-list',
  maxResponseBytes: 100_000,
};

const CLOUD_OPERATIONS = {
  'cloud-auth-check': CLOUD_PVSYSTEMS_OPERATION,
  'cloud-pvsystems': CLOUD_PVSYSTEMS_OPERATION,
  'cloud-pvsystem': { path: '/swqapi/pvsystems/{pvSystemId}' },
  'cloud-aggrdata': {
    path: '/swqapi/pvsystems/{pvSystemId}/aggrdata',
    aggr: true,
    responseShape: 'energy-aggregate',
    maxResponseBytes: 4_000_000,
  },
  'cloud-histdata': {
    path: '/swqapi/pvsystems/{pvSystemId}/histdata',
    historical: true,
    responseShape: 'energy-history',
    maxResponseBytes: 4_000_000,
  },
  'cloud-flowdata': {
    path: '/swqapi/pvsystems/{pvSystemId}/flowdata',
    responseShape: 'power-flow',
  },
  'cloud-messages': {
    path: '/swqapi/pvsystems/{pvSystemId}/messages',
    since: true,
    maxResponseBytes: 2_000_000,
  },
  'cloud-devices-list': {
    path: '/swqapi/pvsystems/{pvSystemId}/devices-list',
    maxResponseBytes: 2_000_000,
  },
  'cloud-errors': {
    path: '/swqapi/pvsystems/{pvSystemId}/errors',
    since: true,
    maxResponseBytes: 2_000_000,
  },
};

const RESPONSE_SHAPES = {
  'inverter-info': {
    kind: 'inverter-info',
    fields: [
      'customName',
      'uniqueId',
      'statusCode',
      'inverterState',
      'errorCode',
      'ratedPvPowerW',
    ],
    notes:
      'GetInverterInfo PVPower is connected/rated PV capacity in watts, not live production.',
  },
  'inverter-realtime': {
    kind: 'inverter-realtime',
    fields: [
      'pacW',
      'pacValuesByDeviceW',
      'dayEnergyWh',
      'yearEnergyWh',
      'totalEnergyWh',
      'deviceStatus',
    ],
    notes:
      'Use PAC.Values by device for Scope=System or PAC.Value for Scope=Device as current AC inverter power in watts.',
  },
  'power-flow': {
    kind: 'power-flow',
    fields: [
      'productionW',
      'consumptionW',
      'gridW',
      'batteryW',
      'selfConsumptionRatio',
    ],
    notes:
      'For the local Solar API, use Body.Data.Site.P_PV as current PV production, P_Load as current load, P_Grid as grid exchange, and P_Akku as battery power in watts.',
  },
  'meter-realtime': {
    kind: 'meter-realtime',
    fields: [
      'powerRealP',
      'energyRealWACSumConsumed',
      'energyRealWACSumProduced',
    ],
    notes:
      'For the local Solar API, Smart Meter data is under Body.Data.<meterId>; PowerReal_P_Sum is current meter/grid power in watts.',
  },
  'storage-realtime': {
    kind: 'storage-realtime',
    fields: [
      'stateOfChargePercent',
      'powerW',
      'energyChargedWh',
      'energyDischargedWh',
    ],
    notes:
      'For the local Solar API, storage data is under Body.Data.<storageId>.Controller; use StateOfCharge_Relative for battery SOC and local-power-flow P_Akku for live battery power.',
  },
  'energy-archive': {
    kind: 'energy-archive',
    fields: ['start', 'end', 'channel', 'values'],
    rollup: 'dailyProducedConsumedWh',
  },
  'energy-aggregate': {
    kind: 'energy-aggregate',
    fields: ['period', 'from', 'to', 'energyProducedWh', 'energyConsumedWh'],
    rollup: 'periodProducedConsumedWh',
  },
  'energy-history': {
    kind: 'energy-history',
    fields: ['from', 'to', 'channels', 'values'],
    rollup: 'timeseriesProducedConsumedWh',
  },
};

const SECRET_FLAGS = new Set([
  '--access-key-id',
  '--access-key-value',
  '--api-key',
  '--password',
  '--secret',
  '--token',
]);

const KNOWN_OPERATION_FLAGS = new Set([
  '--channel',
  '--data-collection',
  '--device-class',
  '--device-id',
  '--end',
  '--from',
  '--period',
  '--pv-system',
  '--scope',
  '--since',
  '--start',
  '--to',
]);

function isSecretFlagArg(arg) {
  for (const flag of SECRET_FLAGS) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return true;
  }
  return false;
}

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload, format = 'pretty') {
  const indent = format === 'pretty' ? 2 : undefined;
  process.stdout.write(`${JSON.stringify(payload, null, indent)}\n`);
}

function usage() {
  return `Fronius skill helper

Usage:
  node skills/fronius/fronius.cjs --format json http-request local-api-version
  node skills/fronius/fronius.cjs --format json http-request local-health
  node skills/fronius/fronius.cjs --format json http-request local-power-flow
  node skills/fronius/fronius.cjs --format json http-request local-inverter-realtime --scope System
  node skills/fronius/fronius.cjs --format json http-request local-meter-realtime --scope System
  node skills/fronius/fronius.cjs --format json http-request local-storage-realtime --scope System
  node skills/fronius/fronius.cjs --format json http-request local-archive --start 2026-05-26 --end 2026-05-27 --channel EnergyReal_WAC_Sum_Produced
  node skills/fronius/fronius.cjs --format json http-request cloud-pvsystems
  node skills/fronius/fronius.cjs --format json http-request cloud-auth-check
  node skills/fronius/fronius.cjs --format json http-request cloud-flowdata --pv-system <id>
  node skills/fronius/fronius.cjs --format json http-request cloud-aggrdata --pv-system <id> --period day --from 2026-05-26
  node skills/fronius/fronius.cjs --format json http-request cloud-messages --pv-system <id> --since 2026-05-20
  node skills/fronius/fronius.cjs --format json http-request cloud-devices-list --pv-system <id>
  node skills/fronius/fronius.cjs --format json http-request cloud-errors --pv-system <id> --since 2026-05-20
  node skills/fronius/fronius.cjs --live --format json http-request cloud-flowdata --pv-system <id>

Global options:
  --format json|pretty       json emits compact output; pretty emits indented output. Defaults to pretty.
  --local-host URL           Local inverter base URL. Defaults to FRONIUS_LOCAL_HOST from the environment.
  --live                     Send one live request through the HybridClaw gateway.
  --help                     Show this help.

Cloud credentials are emitted as secretHeaders only:
  hybridclaw secret set ${SOLARWEB_ACCESS_KEY_ID_SECRET} "<access-key-id>"
  hybridclaw secret set ${SOLARWEB_ACCESS_KEY_VALUE_SECRET} "<access-key-value>"

Secret values are not accepted on the command line.`;
}

function parseArgs(argv) {
  const opts = {
    format: 'pretty',
    help: false,
    live: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--live') {
      opts.live = true;
      continue;
    }
    if (isSecretFlagArg(arg)) {
      fail(
        'Command-line Fronius credential values are not supported. Store Fronius credentials in HybridClaw secrets.',
      );
    }
    if (arg === '--format' || arg === '--local-host') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--') || !value.trim()) {
        fail(`${arg} requires a value.`);
      }
      if (arg === '--format' && !['json', 'pretty'].includes(value)) {
        fail('--format must be json or pretty.');
      }
      opts[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
        value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--') && !KNOWN_OPERATION_FLAGS.has(arg)) {
      fail(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  return { opts, positional };
}

function consumeFlag(args, name, defaultValue = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return defaultValue;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--') || !String(value).trim()) {
    fail(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function consumeRepeatedFlag(args, name) {
  const values = [];
  let index = 0;
  while (index < args.length) {
    if (args[index] !== name) {
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (
      value === undefined ||
      value.startsWith('--') ||
      !String(value).trim()
    ) {
      fail(`${name} requires a value.`);
    }
    values.push(value);
    args.splice(index, 2);
  }
  return values;
}

function assertNoUnexpectedArgs(args) {
  if (args.length === 0) return;
  if (isSecretFlagArg(args[0])) {
    fail(
      'Command-line Fronius credential values are not supported. Store Fronius credentials in HybridClaw secrets.',
    );
  }
  fail(`Unexpected argument: ${args[0]}`);
}

function requireText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) fail(`${label} is required.`);
  return normalized;
}

function requireDate(value, label) {
  const normalized = requireText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    fail(`${label} must use YYYY-MM-DD.`);
  }
  return normalized;
}

function parseScope(raw = 'System') {
  const scope = requireText(raw, '--scope');
  if (!['System', 'Device'].includes(scope)) {
    fail('--scope must be System or Device.');
  }
  return scope;
}

function parseDeviceId(raw, { required = false } = {}) {
  if (raw === undefined) {
    if (required) fail('--device-id is required for Device scope.');
    return undefined;
  }
  if (!/^\d{1,4}$/u.test(String(raw))) {
    fail('--device-id must be an integer between 0 and 9999.');
  }
  return String(Number.parseInt(raw, 10));
}

function parseDataCollection(raw = 'CommonInverterData') {
  const dataCollection = requireText(raw, '--data-collection');
  if (
    ![
      'CumulationInverterData',
      'CommonInverterData',
      '3PInverterData',
      'MinMaxInverterData',
    ].includes(dataCollection)
  ) {
    fail(
      '--data-collection must be CumulationInverterData, CommonInverterData, 3PInverterData, or MinMaxInverterData.',
    );
  }
  return dataCollection;
}

function requireSafeId(value, label) {
  const normalized = requireText(value, label);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(normalized)) {
    fail(`${label} contains unsupported characters.`);
  }
  return normalized;
}

function requireDeviceClass(value) {
  const normalized = requireSafeId(value, '--device-class');
  if (!/^[A-Za-z][A-Za-z0-9_:-]{0,63}$/u.test(normalized)) {
    fail('--device-class must start with a letter.');
  }
  return normalized;
}

function appendQueryParam(searchParams, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    for (const entry of value) appendQueryParam(searchParams, key, entry);
    return;
  }
  searchParams.append(key, String(value));
}

function appendQueryParams(searchParams, query) {
  for (const [key, value] of Object.entries(query)) {
    appendQueryParam(searchParams, key, value);
  }
}

function normalizeLocalBaseUrl(raw) {
  const value = String(raw || process.env[LOCAL_HOST_ENV] || '').trim();
  if (!value) {
    fail(
      `Provide --local-host or set ${LOCAL_HOST_ENV} to the inverter base URL.`,
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    fail('--local-host must be a valid http:// or https:// URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    fail('--local-host must use http:// or https://.');
  }
  if (url.username || url.password) {
    fail('--local-host must not include credentials.');
  }
  if (url.search || url.hash) {
    fail('--local-host must not include a query string or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/+$/u, '');
}

function buildUrl(base, path, query = {}) {
  const url = new URL(path, `${base}/`);
  appendQueryParams(url.searchParams, query);
  return url.toString();
}

function buildLocalRequest(operation, spec, args, opts) {
  const base = normalizeLocalBaseUrl(opts.localHost);
  const query = {};
  let scope;

  if (spec.scoped || spec.archive) {
    scope = parseScope(consumeFlag(args, '--scope', 'System'));
    const deviceId = parseDeviceId(consumeFlag(args, '--device-id'), {
      required: scope === 'Device' && !spec.noDeviceId,
    });
    query.Scope = scope;
    if (deviceId !== undefined && !spec.noDeviceId) query.DeviceId = deviceId;
  }

  if (spec.inverterRealtime) {
    const dataCollection = consumeFlag(
      args,
      '--data-collection',
      scope === 'Device' ? 'CommonInverterData' : undefined,
    );
    if (dataCollection !== undefined) {
      query.DataCollection = parseDataCollection(dataCollection);
    }
  }

  if (spec.archive) {
    query.StartDate = requireDate(consumeFlag(args, '--start'), '--start');
    query.EndDate = requireDate(consumeFlag(args, '--end'), '--end');
    const channels = consumeRepeatedFlag(args, '--channel');
    if (channels.length === 0) fail('--channel is required.');
    for (const channel of channels) {
      if (!/^[A-Za-z0-9_:-]{1,128}$/u.test(channel)) {
        fail('--channel contains unsupported characters.');
      }
    }
    query.Channel = channels;
  }

  if (spec.activeDeviceInfo) {
    query.DeviceClass = requireDeviceClass(
      consumeFlag(args, '--device-class', 'Inverter'),
    );
  }

  assertNoUnexpectedArgs(args);
  return wrapRequest(
    operation,
    {
      url: buildUrl(base, spec.path, query),
      method: 'GET',
      skillName: SKILL_NAME,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: spec.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES,
    },
    spec,
  );
}

function buildCloudSecretHeaders() {
  return [
    {
      name: 'AccessKeyId',
      secretName: SOLARWEB_ACCESS_KEY_ID_SECRET,
      prefix: 'none',
    },
    {
      name: 'AccessKeyValue',
      secretName: SOLARWEB_ACCESS_KEY_VALUE_SECRET,
      prefix: 'none',
    },
  ];
}

function buildCloudRequest(operation, spec, args) {
  const query = {};
  let path = spec.path;
  if (path.includes('{pvSystemId}')) {
    const pvSystemId = requireSafeId(
      consumeFlag(args, '--pv-system'),
      '--pv-system',
    );
    path = path.replace('{pvSystemId}', encodeURIComponent(pvSystemId));
  }

  if (spec.aggr) {
    const period = requireText(
      consumeFlag(args, '--period', 'day'),
      '--period',
    );
    if (!['day', 'week', 'month', 'year'].includes(period)) {
      fail('--period must be day, week, month, or year.');
    }
    query.period = period;
    query.from = requireDate(consumeFlag(args, '--from'), '--from');
    const to = consumeFlag(args, '--to');
    if (to !== undefined) query.to = requireDate(to, '--to');
  }

  if (spec.historical) {
    query.from = requireDate(consumeFlag(args, '--from'), '--from');
    query.to = requireDate(consumeFlag(args, '--to'), '--to');
    const channels = consumeRepeatedFlag(args, '--channel');
    if (channels.length > 0) query.channel = channels;
  }

  if (spec.since) {
    query.since = requireDate(consumeFlag(args, '--since'), '--since');
  }

  assertNoUnexpectedArgs(args);
  const url = new URL(path, SOLARWEB_BASE_URL);
  appendQueryParams(url.searchParams, query);
  return wrapRequest(
    operation,
    {
      url: url.toString(),
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      secretHeaders: buildCloudSecretHeaders(),
      skillName: SKILL_NAME,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: spec.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES,
    },
    spec,
  );
}

function wrapRequest(operation, httpRequest, spec) {
  const payload = {
    command: 'http-request',
    operation,
    transport: operation.startsWith('cloud-')
      ? 'solarweb-cloud'
      : 'local-inverter',
    stakesTier: 'green',
    httpRequest,
    guidance: [
      'Pass only the httpRequest object to the built-in http_request tool.',
      'Stop after the first 401 or 403 response.',
      'For 429 responses, report the rate limit and retry-after guidance instead of retrying in a loop.',
    ],
  };
  if (spec.responseShape) {
    payload.responseShape = RESPONSE_SHAPES[spec.responseShape];
  }
  return payload;
}

function buildRequestFromParsed(parsed) {
  const { opts } = parsed;
  const positional = [...parsed.positional];
  if (opts.help) return { help: usage() };
  const command = positional.shift();
  if (command !== 'http-request') {
    fail('Expected command: http-request.');
  }
  const operation = requireText(positional.shift(), 'operation');
  if (Object.hasOwn(LOCAL_OPERATIONS, operation)) {
    const payload = buildLocalRequest(
      operation,
      LOCAL_OPERATIONS[operation],
      positional,
      opts,
    );
    return opts.live ? { ...payload, command: 'live' } : payload;
  }
  if (Object.hasOwn(CLOUD_OPERATIONS, operation)) {
    const payload = buildCloudRequest(
      operation,
      CLOUD_OPERATIONS[operation],
      positional,
    );
    return opts.live ? { ...payload, command: 'live' } : payload;
  }
  fail(`Unsupported operation: ${operation}`);
}

function buildRequest(argv) {
  return buildRequestFromParsed(parseArgs(argv));
}

async function executeGatewayRequest(httpRequest, options = {}) {
  const gatewayUrl = String(
    options.gatewayUrl ||
      process.env.HYBRIDCLAW_GATEWAY_URL ||
      DEFAULT_GATEWAY_URL,
  ).replace(/\/+$/u, '');
  const gatewayToken =
    options.gatewayToken || process.env.HYBRIDCLAW_GATEWAY_TOKEN || '';
  if (!gatewayToken && !options.allowUnauthenticatedGateway) {
    process.stderr.write(
      'Warning: HYBRIDCLAW_GATEWAY_TOKEN is not set; live gateway request will be sent without Authorization.\n',
    );
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable in this Node.js runtime.');
  }
  const timeoutMs =
    (httpRequest.timeoutMs || DEFAULT_TIMEOUT_MS) + GATEWAY_TIMEOUT_BUFFER_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (gatewayToken) headers.Authorization = `Bearer ${gatewayToken}`;
    const response = await fetchImpl(`${gatewayUrl}/api/http/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify(httpRequest),
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { body: text };
    }
    const status = Number(body.status || response.status || 0);
    const result = {
      command: 'live-result',
      ok: response.ok && status >= 200 && status < 300,
      status,
      statusText: body.statusText || response.statusText || '',
      headers: body.headers || {},
      body: body.body,
    };
    if (typeof body.body === 'string') {
      try {
        result.bodyJson = JSON.parse(body.body);
      } catch {
        // Keep raw body when the upstream response is not JSON.
      }
    }
    if (status === 401 || status === 403) {
      result.stopAfterFirstAuthFailure = true;
      result.guidance =
        'Authorization failed. Stop after this first failed live call and verify stored Fronius credentials or host policy.';
    }
    if (status === 429) {
      const retryAfter =
        result.headers['retry-after'] || result.headers['Retry-After'];
      result.rateLimited = true;
      result.guidance = retryAfter
        ? `Solar.web rate limit hit. Retry after ${retryAfter}.`
        : 'Solar.web rate limit hit. Wait before retrying; do not loop automatically.';
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const payload = buildRequestFromParsed(parsed);
  if (payload.command === 'live') {
    const result = await executeGatewayRequest(payload.httpRequest);
    printJson(result, parsed.opts.format);
    return;
  }
  printJson(payload, parsed.opts.format);
}

if (require.main === module) {
  main().catch((error) => {
    fail(error?.message ? error.message : String(error), 1);
  });
}

module.exports = {
  buildCloudSecretHeaders,
  buildRequest,
  executeGatewayRequest,
};
