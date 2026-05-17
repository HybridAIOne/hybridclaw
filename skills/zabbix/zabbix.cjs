#!/usr/bin/env node
'use strict';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const GATEWAY_TIMEOUT_BUFFER_MS = 5_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SKILL_NAME = 'zabbix';
const SECRET_NAME = 'ZABBIX_API_TOKEN';

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

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usage() {
  return `Zabbix skill helper

Usage:
  node skills/zabbix/zabbix.cjs --format json http-request api-version --base-url https://zabbix.example.com/zabbix
  node skills/zabbix/zabbix.cjs --format json http-request hosts --base-url https://zabbix.example.com/zabbix --monitored-only
  node skills/zabbix/zabbix.cjs --format json http-request problems --base-url https://zabbix.example.com/zabbix --recent --limit 50
  node skills/zabbix/zabbix.cjs --format json http-request triggers-problem --base-url https://zabbix.example.com/zabbix --limit 50
  node skills/zabbix/zabbix.cjs --format json run problems --base-url https://zabbix.example.com/zabbix --recent --limit 50

Global options:
  --format json|pretty        Output format. Defaults to pretty.
  --base-url URL              Zabbix frontend URL or api_jsonrpc.php endpoint.
                              Can also be set with ZABBIX_BASE_URL.
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

Live run mode uses HYBRIDCLAW_GATEWAY_URL and HYBRIDCLAW_GATEWAY_TOKEN when set.`;
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

class ZabbixConfigError extends ZabbixError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'ZabbixConfigError';
  }
}

function parseArgs(argv) {
  const opts = {
    format: 'pretty',
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (SECRET_FLAGS.has(arg)) {
      fail(
        `${arg} is not supported. Store Zabbix credentials in ${SECRET_NAME}.`,
      );
    }
    if (arg === '--format' || arg === '--base-url') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`${arg} requires a value.`);
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

function popFlag(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function popRepeatedFlag(args, name) {
  const values = [];
  let index = args.indexOf(name);
  while (index !== -1) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`${name} requires a value.`);
    }
    values.push(value);
    args.splice(index, 2);
    index = args.indexOf(name);
  }
  return values;
}

function popBoolean(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function normalizeEndpoint(rawUrl) {
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

  if (!['http:', 'https:'].includes(url.protocol)) {
    fail('--base-url must use http or https.');
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
    String(value)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function parseTags(values) {
  return values.map((value) => {
    const text = String(value).trim();
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
    for (const part of String(value).split(',')) {
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

function ensureNoUnknownArgs(args) {
  if (args.length > 0) {
    fail(`Unknown option or argument: ${args[0]}`);
  }
}

function addSharedFilters(params, args, { allowProblemFilters = false } = {}) {
  const hostIds = parseIdList([
    ...popRepeatedFlag(args, '--host-id'),
    ...popRepeatedFlag(args, '--host'),
  ]);
  const groupIds = parseIdList([
    ...popRepeatedFlag(args, '--group-id'),
    ...popRepeatedFlag(args, '--host-group'),
  ]);
  const tags = parseTags(popRepeatedFlag(args, '--tag'));
  const severities = parseSeverities(popRepeatedFlag(args, '--severity'));

  if (hostIds.length > 0) params.hostids = hostIds;
  if (groupIds.length > 0) params.groupids = groupIds;
  if (tags.length > 0) params.tags = tags;
  if (severities.length > 0) params.severities = severities;

  if (!allowProblemFilters) {
    return;
  }

  const acknowledged = popBoolean(args, '--acknowledged');
  const unacknowledged = popBoolean(args, '--unacknowledged');
  const suppressed = popBoolean(args, '--suppressed');
  const unsuppressed = popBoolean(args, '--unsuppressed');
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
    popFlag(args, '--time-from'),
    '--time-from',
  );
  const timeTill = parseUnixSeconds(
    popFlag(args, '--time-till'),
    '--time-till',
  );
  if (timeFrom !== undefined) params.time_from = timeFrom;
  if (timeTill !== undefined) params.time_till = timeTill;
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
    operation: rpcMethod,
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
    id: 1,
    auth: false,
    maxResponseBytes: 200_000,
  });
}

function buildHosts(endpoint, args) {
  const params = {
    output: ['hostid', 'host', 'name', 'status', 'maintenance_status'],
    selectInterfaces: ['interfaceid', 'ip', 'dns', 'type', 'main', 'useip'],
    selectTags: ['tag', 'value'],
    sortfield: 'name',
  };
  if (popBoolean(args, '--monitored-only')) {
    params.monitored_hosts = true;
  }
  addSharedFilters(params, args);
  ensureNoUnknownArgs(args);
  return buildHttpRequest({
    endpoint,
    rpcMethod: 'host.get',
    params,
    id: 2,
    auth: true,
    maxResponseBytes: 2_000_000,
  });
}

function buildProblems(endpoint, args) {
  const limit = parseInteger(
    popFlag(args, '--limit', String(DEFAULT_LIMIT)),
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
  if (popBoolean(args, '--recent')) {
    params.recent = true;
  }
  addSharedFilters(params, args, { allowProblemFilters: true });
  ensureNoUnknownArgs(args);
  return buildHttpRequest({
    endpoint,
    rpcMethod: 'problem.get',
    params,
    id: 3,
    auth: true,
    maxResponseBytes: 4_000_000,
  });
}

function buildTriggersProblem(endpoint, args) {
  const limit = parseInteger(
    popFlag(args, '--limit', String(DEFAULT_LIMIT)),
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
  addSharedFilters(params, args);
  ensureNoUnknownArgs(args);
  return buildHttpRequest({
    endpoint,
    rpcMethod: 'trigger.get',
    params,
    id: 4,
    auth: true,
    maxResponseBytes: 4_000_000,
  });
}

function buildRequest(argv = process.argv.slice(2)) {
  const { opts, positional } = parseArgs(argv);
  if (opts.help) {
    return { help: true };
  }
  if (!['json', 'pretty'].includes(opts.format)) {
    fail('--format must be json or pretty.');
  }
  const mode = positional.shift();
  const command = positional.shift();
  if (!['http-request', 'run'].includes(mode)) {
    fail('Expected command mode: http-request or run.');
  }
  const endpoint = normalizeEndpoint(
    opts.baseUrl || process.env.ZABBIX_BASE_URL,
  );

  let request;
  if (command === 'api-version') {
    ensureNoUnknownArgs(positional);
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

  if (mode === 'run') {
    request.command = 'run';
  }
  return request;
}

function resolveGatewayUrl() {
  return (
    String(process.env.HYBRIDCLAW_GATEWAY_URL || '').trim() ||
    DEFAULT_GATEWAY_URL
  ).replace(/\/+$/u, '');
}

function resolveGatewayToken() {
  return String(
    process.env.HYBRIDCLAW_GATEWAY_TOKEN ||
      process.env.GATEWAY_API_TOKEN ||
      process.env.WEB_API_TOKEN ||
      '',
  ).trim();
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function responseHeadersToObject(headers) {
  if (!headers || typeof headers.forEach !== 'function') {
    return {};
  }
  const result = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function normalizeGatewayResult(wrapper, fallbackStatus) {
  const status = Number(wrapper.status || fallbackStatus || 0);
  const body = typeof wrapper.body === 'string' ? wrapper.body : '';
  const bodyJson = parseJsonMaybe(body);
  return {
    ok: wrapper.ok !== false,
    status,
    statusText: wrapper.statusText || '',
    headers: wrapper.headers || {},
    body,
    bodyJson,
    bodyTruncated: wrapper.bodyTruncated === true,
    maxResponseBytes: wrapper.maxResponseBytes,
  };
}

function zabbixCredentialMessage(status, body) {
  const suffix = body ? ` Zabbix response: ${body}` : '';
  return `Zabbix returned HTTP ${status} for the first live call. Check ZABBIX_API_TOKEN, token permissions, and the configured Zabbix frontend URL before retrying.${suffix}`;
}

async function executeZabbixGatewayRequest(httpRequest, options = {}) {
  const gatewayUrl = String(options.gatewayUrl || resolveGatewayUrl()).replace(
    /\/+$/u,
    '',
  );
  const gatewayToken = options.gatewayToken || resolveGatewayToken();
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ZabbixConfigError('fetch is not available for Zabbix requests.');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (gatewayToken) {
    headers.Authorization = `Bearer ${gatewayToken}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    (httpRequest.timeoutMs || DEFAULT_TIMEOUT_MS) + GATEWAY_TIMEOUT_BUFFER_MS,
  );
  let response;
  let text = '';
  try {
    response = await fetchImpl(`${gatewayUrl}/api/http/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify(httpRequest),
      signal: controller.signal,
    });
    text = await response.text();
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ZabbixError(
      `Gateway proxy returned HTTP ${response.status} for Zabbix request: ${text}`,
      { status: response.status, body: text },
    );
  }

  const parsed = parseJsonMaybe(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: true,
      status: response.status,
      headers: responseHeadersToObject(response.headers),
      body: text,
      bodyJson: null,
    };
  }

  const normalized = normalizeGatewayResult(parsed, response.status);
  if (normalized.bodyTruncated) {
    throw new ZabbixError(
      `Zabbix response was truncated by the gateway at ${normalized.maxResponseBytes || 'the configured'} bytes. Narrow the query or increase maxResponseBytes.`,
      normalized,
    );
  }
  if (parsed.ok === false) {
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
  if (result.command === 'run') {
    try {
      printJson(await executeZabbixGatewayRequest(result.httpRequest));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = error instanceof ZabbixCredentialError ? 78 : 1;
    }
    return;
  }
  printJson(result);
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
  ZabbixConfigError,
  ZabbixCredentialError,
  ZabbixError,
  buildRequest,
  executeZabbixGatewayRequest,
  normalizeEndpoint,
};
