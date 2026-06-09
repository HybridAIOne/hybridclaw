#!/usr/bin/env node
'use strict';

const {
  executeGatewayRequest: executeSharedGatewayRequest,
} = require('../shared/gateway-http.cjs');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SKILL_NAME = 'zabbix';
const SECRET_NAME = 'ZABBIX_API_TOKEN';
const GATEWAY_TOKEN_ENV_NAMES = ['HYBRIDCLAW_GATEWAY_TOKEN'];

const RPC_IDS = {
  apiVersion: 1,
  hosts: 2,
  problems: 3,
  triggersProblem: 4,
};

const SECRET_FLAGS = new Set([
  '--api-token',
  '--auth-token',
  '--authorization',
  '--authorization-header',
  '--bearer',
  '--password',
  '--session',
  '--session-token',
  '--token',
  '--user',
  '--username',
]);

const SEVERITIES = new Map([
  ['0', 0],
  ['not-classified', 0],
  ['not_classified', 0],
  ['notclassified', 0],
  ['1', 1],
  ['information', 1],
  ['info', 1],
  ['2', 2],
  ['warning', 2],
  ['warn', 2],
  ['3', 3],
  ['average', 3],
  ['4', 4],
  ['high', 4],
  ['5', 5],
  ['disaster', 5],
]);

const PROBLEM_ONLY_FLAGS = new Set([
  '--acknowledged',
  '--unacknowledged',
  '--suppressed',
  '--unsuppressed',
  '--time-from',
  '--time-till',
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
  return `Zabbix skill helper

Usage:
  node skills/zabbix/zabbix.cjs --format json http-request api-version --base-url https://zabbix.example.com/zabbix
  node skills/zabbix/zabbix.cjs --format json http-request hosts --base-url https://zabbix.example.com/zabbix --monitored-only
  node skills/zabbix/zabbix.cjs --format json http-request problems --base-url https://zabbix.example.com/zabbix --recent --limit 50
  node skills/zabbix/zabbix.cjs --format json http-request triggers-problem --base-url https://zabbix.example.com/zabbix --limit 50
  node skills/zabbix/zabbix.cjs --live --format json http-request problems --base-url https://zabbix.example.com/zabbix --recent --limit 50

Global options:
  --format json|pretty        json emits compact output; pretty emits indented output. Defaults to pretty.
  --base-url URL              Zabbix frontend URL or api_jsonrpc.php endpoint.
                              Can also be set with ZABBIX_BASE_URL.
  --live                      Send one live request through the HybridClaw gateway.
  --allow-http                Allow an http:// Zabbix base URL. HTTPS is required by default.
  --help                      Show this help.

Filters:
  --host-id ID                Filter by Zabbix host id. Repeatable.
  --host ID                   Alias for --host-id.
  --group-id ID               Filter by Zabbix host group id. Repeatable.
  --host-group ID             Alias for --group-id.
  --tag TAG[=VALUE]           Filter by Zabbix tag. Repeatable.
  --severity 0-5|name         Filter by severity. Repeatable or comma-separated.
  --acknowledged              Only acknowledged problems.
  --unacknowledged            Only unacknowledged problems.
  --suppressed                Only suppressed problems.
  --unsuppressed              Only unsuppressed problems.
  --time-from UNIX_SECONDS    Lower problem event timestamp.
  --time-till UNIX_SECONDS    Upper problem event timestamp.

Secret values are not accepted on the command line. Store the token with:
  hybridclaw secret set ZABBIX_API_TOKEN "<token>"

Live mode uses HYBRIDCLAW_GATEWAY_URL and HYBRIDCLAW_GATEWAY_TOKEN when set.`;
}

class ZabbixError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ZabbixError';
    this.details = details;
  }
}

class ZabbixCredentialError extends ZabbixError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'ZabbixCredentialError';
  }
}

function parseArgs(argv) {
  const opts = {
    allowHttp: false,
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
    if (arg === '--allow-http') {
      opts.allowHttp = true;
      continue;
    }
    if (SECRET_FLAGS.has(arg)) {
      fail(
        `${arg} is not supported. Store Zabbix credentials in ${SECRET_NAME}.`,
      );
    }
    if (arg === '--format' || arg === '--base-url') {
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
    positional.push(arg);
  }

  return { opts, positional };
}

function normalizeEndpoint(rawUrl, { allowHttp = false } = {}) {
  const text = String(rawUrl || '').trim();
  if (!text) {
    fail('--base-url is required or ZABBIX_BASE_URL must be set.');
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    fail('--base-url must be a valid URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('--base-url must use https.');
  }
  if (url.protocol === 'http:' && !allowHttp) {
    fail(
      '--base-url must use https. Pass --allow-http only for trusted local or private Zabbix frontends.',
    );
  }
  if (url.username || url.password) {
    fail('--base-url must not include credentials.');
  }
  if (url.search || url.hash) {
    fail('--base-url must not include a query string or fragment.');
  }

  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/api_jsonrpc.php')) {
    pathname = `${pathname}/api_jsonrpc.php`;
  }
  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }
  url.pathname = pathname.replace(/\/{2,}/g, '/');
  return url.toString();
}

function parseInteger(raw, label, min, max) {
  if (!/^\d+$/.test(String(raw))) {
    fail(`${label} must be an integer between ${min} and ${max}.`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    fail(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function parseIdList(values) {
  return values.flatMap((value) =>
    normalizeText(value)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function normalizeText(value) {
  return String(value).trim();
}

function parseTags(values) {
  return values.map((value) => {
    const text = normalizeText(value);
    if (!text) {
      fail('--tag cannot be empty.');
    }
    const equalsIndex = text.indexOf('=');
    if (equalsIndex === -1) {
      return { tag: text };
    }
    const tag = text.slice(0, equalsIndex).trim();
    const tagValue = text.slice(equalsIndex + 1).trim();
    if (!tag) {
      fail('--tag name cannot be empty.');
    }
    return { tag, value: tagValue };
  });
}

function parseSeverities(values) {
  const severities = [];
  for (const value of values) {
    for (const part of normalizeText(value).split(',')) {
      const key = part.trim().toLowerCase();
      if (!key) {
        continue;
      }
      const severity = SEVERITIES.get(key);
      if (severity === undefined) {
        fail(
          '--severity must be one of 0-5, not-classified, information, warning, average, high, or disaster.',
        );
      }
      severities.push(severity);
    }
  }
  return [...new Set(severities)];
}

function parseUnixSeconds(raw, label) {
  if (raw === undefined) {
    return undefined;
  }
  return parseInteger(raw, label, 0, 4_102_444_800);
}

function parseCommandOptions(args, spec = {}) {
  const booleans = new Set(spec.booleans || []);
  const values = new Set(spec.values || []);
  const repeated = new Set(spec.repeated || []);
  const result = {
    booleans: {},
    values: {},
    repeated: {},
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!spec.allowProblemFilters && PROBLEM_ONLY_FLAGS.has(arg)) {
      fail(`${arg} is only valid for the problems command.`);
    }
    if (booleans.has(arg)) {
      result.booleans[arg] = true;
      continue;
    }
    if (values.has(arg) || repeated.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--') || !value.trim()) {
        fail(`${arg} requires a value.`);
      }
      if (repeated.has(arg)) {
        result.repeated[arg] ||= [];
        result.repeated[arg].push(value);
      } else {
        result.values[arg] = value;
      }
      index += 1;
      continue;
    }
    fail(`Unknown option or argument: ${arg}`);
  }

  return result;
}

function addSharedFilters(params, options) {
  const hostIds = parseIdList([
    ...(options.repeated['--host-id'] || []),
    ...(options.repeated['--host'] || []),
  ]);
  const groupIds = parseIdList([
    ...(options.repeated['--group-id'] || []),
    ...(options.repeated['--host-group'] || []),
  ]);
  const tags = parseTags(options.repeated['--tag'] || []);
  const severities = parseSeverities(options.repeated['--severity'] || []);

  if (hostIds.length > 0) params.hostids = hostIds;
  if (groupIds.length > 0) params.groupids = groupIds;
  if (tags.length > 0) params.tags = tags;
  if (severities.length > 0) params.severities = severities;
}

function addProblemFilters(params, options) {
  const acknowledged = options.booleans['--acknowledged'] === true;
  const unacknowledged = options.booleans['--unacknowledged'] === true;
  const suppressed = options.booleans['--suppressed'] === true;
  const unsuppressed = options.booleans['--unsuppressed'] === true;
  if (acknowledged && unacknowledged) {
    fail('Use only one of --acknowledged or --unacknowledged.');
  }
  if (suppressed && unsuppressed) {
    fail('Use only one of --suppressed or --unsuppressed.');
  }
  if (acknowledged) params.acknowledged = true;
  if (unacknowledged) params.acknowledged = false;
  if (suppressed) params.suppressed = true;
  if (unsuppressed) params.suppressed = false;

  const timeFrom = parseUnixSeconds(
    options.values['--time-from'],
    '--time-from',
  );
  const timeTill = parseUnixSeconds(
    options.values['--time-till'],
    '--time-till',
  );
  if (timeFrom !== undefined) params.time_from = timeFrom;
  if (timeTill !== undefined) params.time_till = timeTill;
}

function parseReadOptions(args, extra = {}) {
  return parseCommandOptions(args, {
    allowProblemFilters: extra.allowProblemFilters === true,
    booleans: [
      ...(extra.booleans || []),
      '--acknowledged',
      '--unacknowledged',
      '--suppressed',
      '--unsuppressed',
    ],
    values: [...(extra.values || []), '--time-from', '--time-till'],
    repeated: [
      '--host-id',
      '--host',
      '--group-id',
      '--host-group',
      '--tag',
      '--severity',
      ...(extra.repeated || []),
    ],
  });
}

function buildRpc(method, params, id) {
  return {
    jsonrpc: '2.0',
    method,
    params,
    id,
  };
}

function buildHttpRequest({
  endpoint,
  rpcMethod,
  params,
  id,
  auth,
  maxResponseBytes,
}) {
  const httpRequest = {
    url: endpoint,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json-rpc',
    },
    json: buildRpc(rpcMethod, params, id),
    skillName: SKILL_NAME,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes,
  };
  if (auth) {
    httpRequest.bearerSecretName = SECRET_NAME;
  }
  return {
    command: 'http-request',
    httpRequest,
    costMeasurement: {
      system: 'UsageTotals',
      subLimitKey: SKILL_NAME,
    },
  };
}

function buildApiVersion(endpoint) {
  return buildHttpRequest({
    endpoint,
    rpcMethod: 'apiinfo.version',
    params: {},
    id: RPC_IDS.apiVersion,
    auth: false,
    maxResponseBytes: 200_000,
  });
}

function buildHosts(endpoint, args) {
  const options = parseReadOptions(args, {
    booleans: ['--monitored-only'],
  });
  const params = {
    output: ['hostid', 'host', 'name', 'status', 'maintenance_status'],
    selectInterfaces: ['interfaceid', 'ip', 'dns', 'type', 'main', 'useip'],
    selectTags: ['tag', 'value'],
    sortfield: 'name',
  };
  if (options.booleans['--monitored-only']) {
    params.monitored_hosts = true;
  }
  addSharedFilters(params, options);
  return buildHttpRequest({
    endpoint,
    rpcMethod: 'host.get',
    params,
    id: RPC_IDS.hosts,
    auth: true,
    maxResponseBytes: 2_000_000,
  });
}

function buildProblems(endpoint, args) {
  const options = parseReadOptions(args, {
    allowProblemFilters: true,
    booleans: ['--recent'],
    values: ['--limit'],
  });
  const limit = parseInteger(
    options.values['--limit'] || String(DEFAULT_LIMIT),
    '--limit',
    1,
    MAX_LIMIT,
  );
  const params = {
    output: 'extend',
    selectAcknowledges: 'extend',
    selectTags: 'extend',
    selectSuppressionData: 'extend',
    sortfield: ['eventid'],
    sortorder: 'DESC',
    limit,
  };
  if (options.booleans['--recent']) {
    params.recent = true;
  }
  addSharedFilters(params, options);
  addProblemFilters(params, options);
  return buildHttpRequest({
    endpoint,
    rpcMethod: 'problem.get',
    params,
    id: RPC_IDS.problems,
    auth: true,
    maxResponseBytes: 4_000_000,
  });
}

function buildTriggersProblem(endpoint, args) {
  const options = parseReadOptions(args, {
    values: ['--limit'],
  });
  const limit = parseInteger(
    options.values['--limit'] || String(DEFAULT_LIMIT),
    '--limit',
    1,
    MAX_LIMIT,
  );
  const params = {
    output: ['triggerid', 'description', 'priority', 'lastchange'],
    selectHosts: ['hostid', 'host', 'name'],
    selectTags: 'extend',
    filter: {
      value: 1,
    },
    sortfield: 'priority',
    sortorder: 'DESC',
    limit,
  };
  addSharedFilters(params, options);
  return buildHttpRequest({
    endpoint,
    rpcMethod: 'trigger.get',
    params,
    id: RPC_IDS.triggersProblem,
    auth: true,
    maxResponseBytes: 4_000_000,
  });
}

function buildRequest(argv = process.argv.slice(2)) {
  const { opts, positional } = parseArgs(argv);
  if (opts.help) {
    return { help: true };
  }
  const mode = positional.shift();
  const command = positional.shift();
  if (mode !== 'http-request') {
    fail('Expected command mode: http-request.');
  }
  const endpoint = normalizeEndpoint(
    opts.baseUrl || process.env.ZABBIX_BASE_URL,
    { allowHttp: opts.allowHttp },
  );

  let request;
  if (command === 'api-version') {
    parseCommandOptions(positional);
    request = buildApiVersion(endpoint);
  } else if (command === 'hosts') {
    request = buildHosts(endpoint, positional);
  } else if (command === 'problems') {
    request = buildProblems(endpoint, positional);
  } else if (command === 'triggers-problem') {
    request = buildTriggersProblem(endpoint, positional);
  } else {
    fail(`Unsupported Zabbix operation: ${command || '(missing)'}`);
  }

  if (opts.live) {
    request.command = 'live';
  }
  request.format = opts.format;
  return request;
}

function zabbixCredentialMessage(status, body) {
  const suffix = body ? ` Zabbix response: ${body}` : '';
  return `Zabbix returned HTTP ${status} for the first live call. Check ZABBIX_API_TOKEN, token permissions, and the configured Zabbix frontend URL before retrying.${suffix}`;
}

async function executeZabbixGatewayRequest(httpRequest, options = {}) {
  let normalized;
  try {
    normalized = await executeSharedGatewayRequest(httpRequest, {
      ...options,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      gatewayTokenEnvNames: GATEWAY_TOKEN_ENV_NAMES,
      rejectEnvelopeErrors: false,
      serviceName: 'Zabbix',
      truncationGuidance: 'Narrow the query or increase maxResponseBytes.',
    });
  } catch (error) {
    throw new ZabbixError(
      error instanceof Error ? error.message : String(error),
      error && typeof error === 'object' ? error : {},
    );
  }

  if (normalized.ok === false) {
    if (normalized.status === 401 || normalized.status === 403) {
      throw new ZabbixCredentialError(
        zabbixCredentialMessage(normalized.status, normalized.body),
        normalized,
      );
    }
    throw new ZabbixError(
      `Zabbix returned HTTP ${normalized.status || 'error'}: ${
        normalized.body || normalized.statusText
      }`,
      normalized,
    );
  }
  if (normalized.bodyJson?.error) {
    const error = normalized.bodyJson.error;
    throw new ZabbixError(
      `Zabbix JSON-RPC ${httpRequest.json?.method || 'request'} failed: ${error.code} ${error.message}${
        error.data ? ` (${error.data})` : ''
      }`,
      { ...normalized, zabbixError: error },
    );
  }
  return normalized;
}

async function main() {
  const result = buildRequest();
  if (result.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const format = result.format || 'pretty';
  delete result.format;
  if (result.command === 'live') {
    try {
      printJson(await executeZabbixGatewayRequest(result.httpRequest), format);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = error instanceof ZabbixCredentialError ? 78 : 1;
    }
    return;
  }
  printJson(result, format);
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
  ZabbixCredentialError,
  ZabbixError,
  buildRequest,
  executeZabbixGatewayRequest,
  normalizeEndpoint,
};
