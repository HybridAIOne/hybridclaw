#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const {
  executeGatewayRequest: executeSharedGatewayRequest,
  resolveGatewayToken,
  resolveGatewayUrl,
} = require('../shared/gateway-http.cjs');

const SKILL_NAME = 't-cloud-public';
const DEFAULT_REGION = 'eu-de';
const DEFAULT_PROJECT_SECRET = 'OTC_PROJECT_ID';
const DEFAULT_ACCESS_KEY_SECRET = 'OTC_ACCESS_KEY_ID';
const DEFAULT_SECRET_KEY_SECRET = 'OTC_SECRET_ACCESS_KEY';
const DEFAULT_ENTERPRISE_DASHBOARD_TOKEN_SECRET =
  'OTC_ENTERPRISE_DASHBOARD_TOKEN';
const DEFAULT_TIMEOUT_MS = 30_000;
const GATEWAY_TOKEN_ENV_NAMES = [
  'HYBRIDCLAW_GATEWAY_TOKEN',
  'GATEWAY_API_TOKEN',
  'WEB_API_TOKEN',
];
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');

const COST_MEASUREMENT = {
  system: 'UsageTotals',
  source: 'HybridClaw usage_events',
  scope: 'per assistant run/session',
};

const REQUIRED_SECRET_NAMES = [
  DEFAULT_ACCESS_KEY_SECRET,
  DEFAULT_SECRET_KEY_SECRET,
  DEFAULT_PROJECT_SECRET,
];
const ENTERPRISE_DASHBOARD_SECRET_NAMES = [
  DEFAULT_ENTERPRISE_DASHBOARD_TOKEN_SECRET,
];

const ENDPOINT_SERVICES = new Set([
  'cbr',
  'cce',
  'ces',
  'cts',
  'ecs',
  'elb',
  'evs',
  'iam',
  'kms',
  'lts',
  'obs',
  'rds',
  'sfs',
  'vpc',
  'waf',
]);

const OPERATION_DEFS = {
  regions: {
    service: 'iam',
    path: '/v3/regions',
    project: false,
    query: ['marker', 'limit'],
  },
  projects: {
    service: 'iam',
    path: '/v3/projects',
    project: false,
    query: ['name', 'domain_id', 'parent_id'],
  },
  'service-endpoints': {
    service: 'iam',
    path: '/v3/endpoints',
    project: false,
    query: ['service_id', 'interface', 'region', 'enabled'],
  },
  services: {
    service: 'iam',
    path: '/v3/services',
    project: false,
    query: ['name', 'type', 'enabled'],
  },
  'service-status': {
    service: 'status-dashboard',
    url: 'https://status.otc-service.com/',
    auth: false,
    query: [],
  },
  'billing-daily-consumption': {
    service: 'enterprise-dashboard',
    url: 'https://api-enterprise-dashboard.otc-service.com/v2/daily/consumption/',
    auth: 'bearer',
    stakesTier: 'amber',
    defaultDate: true,
    query: [
      'consumption_type',
      'contract',
      'date',
      'month',
      'product',
      'product_description',
      'project_name',
      'resource_id',
      'show_tag',
      'tag_key',
      'tag_value',
      'week',
      'year',
    ],
  },
  'billing-hourly-consumption': {
    service: 'enterprise-dashboard',
    url: 'https://api-enterprise-dashboard.otc-service.com/v2/hourly/consumption/',
    auth: 'bearer',
    stakesTier: 'amber',
    defaultDate: true,
    query: [
      'consumption_type',
      'contract',
      'date',
      'hour',
      'month',
      'product',
      'product_description',
      'project_name',
      'resource_id',
      'show_tag',
      'tag_key',
      'tag_value',
      'week',
      'year',
    ],
  },
  quotas: {
    service: 'ecs',
    path: '/v1/{project_id}/cloudservers/limits',
    query: [],
  },
  servers: {
    service: 'ecs',
    path: '/v2.1/{project_id}/servers/detail',
    query: ['limit', 'marker', 'name', 'status', 'ip'],
  },
  server: {
    service: 'ecs',
    path: '/v2.1/{project_id}/servers/{server_id}',
    required: ['server_id'],
    query: [],
  },
  flavors: {
    service: 'ecs',
    path: '/v2.1/{project_id}/flavors/detail',
    query: ['limit', 'marker', 'minDisk', 'minRam'],
  },
  networks: {
    service: 'vpc',
    path: '/v1/{project_id}/vpcs',
    query: ['limit', 'marker', 'id'],
  },
  subnets: {
    service: 'vpc',
    path: '/v1/{project_id}/subnets',
    query: ['limit', 'marker', 'vpc_id'],
  },
  'security-groups': {
    service: 'vpc',
    path: '/v1/{project_id}/security-groups',
    query: ['limit', 'marker', 'vpc_id'],
  },
  eips: {
    service: 'vpc',
    path: '/v1/{project_id}/publicips',
    query: ['limit', 'marker', 'ip_version'],
  },
  'load-balancers': {
    service: 'elb',
    path: '/v2.0/lbaas/loadbalancers',
    query: ['limit', 'marker', 'name', 'vip_address'],
  },
  volumes: {
    service: 'evs',
    path: '/v2/{project_id}/volumes/detail',
    query: ['limit', 'marker', 'name', 'status'],
  },
  snapshots: {
    service: 'evs',
    path: '/v2/{project_id}/cloudsnapshots/detail',
    query: ['limit', 'marker', 'name', 'status', 'volume_id'],
  },
  backups: {
    service: 'cbr',
    path: '/v3/{project_id}/backups',
    query: ['limit', 'marker', 'name', 'status', 'resource_id'],
  },
  'sfs-shares': {
    service: 'sfs',
    path: '/v2/{project_id}/shares/detail',
    query: ['limit', 'offset', 'name', 'status'],
  },
  'obs-bucket': {
    service: 'obs',
    obsBucket: true,
    required: ['bucket'],
    query: ['prefix', 'marker', 'max-keys'],
  },
  'cce-clusters': {
    service: 'cce',
    path: '/api/v3/projects/{project_id}/clusters',
    query: ['type', 'status'],
  },
  'cce-nodes': {
    service: 'cce',
    path: '/api/v3/projects/{project_id}/clusters/{cluster_id}/nodes',
    required: ['cluster_id'],
    query: [],
  },
  'rds-instances': {
    service: 'rds',
    path: '/v3/{project_id}/instances',
    query: [
      'limit',
      'offset',
      'id',
      'name',
      'type',
      'datastore_type',
      'vpc_id',
    ],
  },
  'cloud-eye-alarms': {
    service: 'ces',
    path: '/V1.0/{project_id}/alarms',
    query: ['limit', 'start', 'order', 'alarm_name', 'alarm_state'],
  },
  traces: {
    service: 'cts',
    path: '/v3/{project_id}/traces',
    query: ['limit', 'next', 'from', 'to', 'trace_name', 'service_type'],
  },
  'log-groups': {
    service: 'lts',
    path: '/v2.0/{project_id}/log-groups',
    query: ['limit', 'offset', 'log_group_name'],
  },
  'kms-keys': {
    service: 'kms',
    path: '/v1.0/{project_id}/kms/list-keys',
    method: 'POST',
    bodyFromQuery: ['limit', 'marker', 'key_state'],
  },
  'waf-policies': {
    service: 'waf',
    path: '/v1/{project_id}/waf/policy',
    query: ['page', 'pagesize', 'name'],
  },
};
OPERATION_DEFS.vpcs = OPERATION_DEFS.networks;

function validateOperationDefinitions() {
  for (const [operation, def] of Object.entries(OPERATION_DEFS)) {
    if (def.url) continue;
    if (!ENDPOINT_SERVICES.has(def.service)) {
      die(
        `Invalid ${SKILL_NAME} operation "${operation}": unsupported service ${def.service}.`,
      );
    }
  }
}
validateOperationDefinitions();

const READ_OPERATIONS = new Set(Object.keys(OPERATION_DEFS));
const WRITE_KEYWORDS =
  /\b(create|delete|destroy|remove|reboot|restart|start|stop|resize|restore|attach|detach|modify|update|change|open port|close port|grant|revoke|rotate|encrypt|decrypt)\b/i;
const ACCOUNT_BILLING_KEYWORDS =
  /\b(billing|bill|invoice|invoices|charge|charges|charged|costs?|spend|usage cost|account cost|orders?|kosten|rechnung|rechnungen|geb[uü]hren|ausgaben|bestellungen)\b/i;

function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function popFlag(args, name, fallback = undefined, options = {}) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (
    value === undefined ||
    (!options.allowDashValue && value.startsWith('--'))
  ) {
    die(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function assertNoUnexpectedArgs(args) {
  if (args.length > 0) {
    die(`Unexpected arguments: ${args.join(' ')}`);
  }
}

function requireText(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function parseLimit(raw, fallback = undefined) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) die('--limit must be a positive integer.');
  const value = Number.parseInt(String(raw), 10);
  if (value < 1 || value > 1000) die('--limit must be between 1 and 1000.');
  return String(value);
}

function todayLocalIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validateDate(value, label) {
  const normalized = requireText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    die(`${label} must use YYYY-MM-DD.`);
  }
  return normalized;
}

function validateBoolean(value, label) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!['true', 'false'].includes(normalized)) {
    die(`${label} must be true or false.`);
  }
  return normalized;
}

function validateIntegerRange(value, label, min, max) {
  const normalized = requireText(value, label);
  if (!/^\d+$/.test(normalized)) die(`${label} must be an integer.`);
  const parsed = Number.parseInt(normalized, 10);
  if (parsed < min || parsed > max) {
    die(`${label} must be between ${min} and ${max}.`);
  }
  return normalized;
}

function validateRegion(region) {
  if (!/^[a-z]{2}-[a-z0-9-]{2,20}$/i.test(region)) {
    die(`Invalid OTC region: ${region}`);
  }
  return region.toLowerCase();
}

function validateSecretName(value, label) {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
    die(`${label} must be an uppercase HybridClaw secret name.`);
  }
  return value;
}

function validatePathValue(value, label) {
  const normalized = requireText(value, label);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) {
    die(`${label} contains unsupported characters.`);
  }
  return encodeURIComponent(normalized);
}

function endpointHost(service, region) {
  if (!ENDPOINT_SERVICES.has(service)) {
    die(`No OTC endpoint mapping for service: ${service}`);
  }
  return `${service}.${region}.otc.t-systems.com`;
}

function replacePathParams(pathTemplate, params) {
  return pathTemplate.replace(/\{([a-z_]+)\}/g, (_match, key) => {
    if (key === 'project_id') return '{project_id}';
    return validatePathValue(params[key], `--${key.replaceAll('_', '-')}`);
  });
}

function appendQuery(url, values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${url}?${text}` : url;
}

function readCommonFlags(args) {
  const region = validateRegion(
    popFlag(args, '--region') || process.env.OTC_REGION || DEFAULT_REGION,
  );
  const projectId =
    popFlag(args, '--project-id') || process.env.OTC_PROJECT_ID || undefined;
  const projectIdSecretName = validateSecretName(
    popFlag(args, '--project-id-secret') || DEFAULT_PROJECT_SECRET,
    '--project-id-secret',
  );
  const accessKeyIdSecretName = validateSecretName(
    popFlag(args, '--access-key-id-secret') || DEFAULT_ACCESS_KEY_SECRET,
    '--access-key-id-secret',
  );
  const secretAccessKeySecretName = validateSecretName(
    popFlag(args, '--secret-access-key-secret') || DEFAULT_SECRET_KEY_SECRET,
    '--secret-access-key-secret',
  );
  const securityTokenSecretName = popFlag(args, '--security-token-secret');
  if (securityTokenSecretName) {
    validateSecretName(securityTokenSecretName, '--security-token-secret');
  }
  const enterpriseDashboardTokenSecretName = validateSecretName(
    popFlag(args, '--enterprise-dashboard-token-secret') ||
      DEFAULT_ENTERPRISE_DASHBOARD_TOKEN_SECRET,
    '--enterprise-dashboard-token-secret',
  );
  return {
    region,
    projectId,
    projectIdSecretName,
    accessKeyIdSecretName,
    secretAccessKeySecretName,
    securityTokenSecretName,
    enterpriseDashboardTokenSecretName,
  };
}

function makeProjectPath(path, common) {
  if (path.includes('{project_id}') && common.projectId) {
    return path.replaceAll(
      '{project_id}',
      validatePathValue(common.projectId, '--project-id'),
    );
  }
  return path.replaceAll(
    '{project_id}',
    `<secret:${common.projectIdSecretName}>`,
  );
}

function collectQuery(args, names) {
  const query = {};
  for (const name of names) {
    const flag = `--${name.replaceAll('_', '-')}`;
    const raw = popFlag(args, flag, undefined, { allowDashValue: true });
    if (raw === undefined) continue;
    if (name === 'limit' || name === 'pagesize') query[name] = parseLimit(raw);
    else if (name === 'date') query[name] = validateDate(raw, flag);
    else if (name === 'show_tag') query[name] = validateBoolean(raw, flag);
    else if (name === 'hour')
      query[name] = validateIntegerRange(raw, flag, 0, 23);
    else if (name === 'month')
      query[name] = validateIntegerRange(raw, flag, 1, 12);
    else if (name === 'week')
      query[name] = validateIntegerRange(raw, flag, 1, 53);
    else if (name === 'year')
      query[name] = validateIntegerRange(raw, flag, 2020, 2100);
    else if (name === 'contract' || name === 'product') {
      query[name] = validateIntegerRange(raw, flag, 1, 9_999_999_999);
    } else query[name] = raw;
  }
  return query;
}

function collectJson(args, names) {
  const json = {};
  for (const name of names) {
    const flag = `--${name.replaceAll('_', '-')}`;
    const raw = popFlag(args, flag, undefined, { allowDashValue: true });
    if (raw === undefined) continue;
    json[name] = name === 'limit' ? Number.parseInt(parseLimit(raw), 10) : raw;
  }
  return json;
}

function buildHttpRequest(operation, args) {
  const def = OPERATION_DEFS[operation];
  if (!def)
    die(`Unknown T Cloud Public / Open Telekom Cloud operation: ${operation}`);
  const common = readCommonFlags(args);
  const params = {};
  for (const required of def.required || []) {
    const flag = `--${required.replaceAll('_', '-')}`;
    params[required] = popFlag(args, flag);
  }
  let host = def.url ? '' : endpointHost(def.service, common.region);
  let path = def.path ? replacePathParams(def.path, params) : '/';
  let url;
  if (def.obsBucket) {
    const bucket = requireText(params.bucket, '--bucket');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      die('--bucket must be a valid OBS bucket DNS label.');
    }
    host = `${bucket}.obs.${common.region}.otc.t-systems.com`;
    path = '/';
  }
  if (def.url) {
    url = def.url;
  } else {
    path = makeProjectPath(path, common);
    url = `https://${host}${path}`;
  }

  let json;
  if (def.bodyFromQuery) {
    json = collectJson(args, def.bodyFromQuery);
  }
  const query = collectQuery(args, def.query || []);
  if (
    def.defaultDate &&
    !query.date &&
    !query.month &&
    !query.week &&
    !query.year
  ) {
    query.date = todayLocalIsoDate();
  }
  url = appendQuery(url, query);
  assertNoUnexpectedArgs(args);

  const request = {
    url,
    method: def.method || 'GET',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skillName: SKILL_NAME,
    stakesTier: def.stakesTier || 'green',
  };
  if (def.auth === 'bearer') {
    request.headers = {
      'Content-Type': 'application/x-ndjson',
    };
    request.bearerSecretName = common.enterpriseDashboardTokenSecretName;
  } else if (def.auth !== false) {
    request.otcAkSk = {
      accessKeyIdSecretName: common.accessKeyIdSecretName,
      secretAccessKeySecretName: common.secretAccessKeySecretName,
      ...(common.securityTokenSecretName
        ? { securityTokenSecretName: common.securityTokenSecretName }
        : {}),
    };
  }
  if (json && Object.keys(json).length > 0) request.json = json;
  return {
    command: 'http-request',
    operation,
    stakesTier: def.stakesTier || 'green',
    httpRequest: request,
    costMeasurement: COST_MEASUREMENT,
    liveExecution: liveExecutionMetadata(operation),
  };
}

function liveExecutionMetadata(operation) {
  const def = OPERATION_DEFS[operation] || {};
  const publicOperation = def.auth === false;
  const enterpriseDashboardOperation = def.auth === 'bearer';
  const requiresConfiguredSecrets = publicOperation
    ? []
    : enterpriseDashboardOperation
      ? ENTERPRISE_DASHBOARD_SECRET_NAMES
      : REQUIRED_SECRET_NAMES;
  return {
    mode: enterpriseDashboardOperation
      ? 'live-t-cloud-public-enterprise-dashboard-api'
      : 'live-t-cloud-public-api',
    requiresConfiguredSecrets,
    optionalConfiguredSecrets:
      publicOperation || enterpriseDashboardOperation
        ? []
        : ['OTC_SECURITY_TOKEN'],
    callPolicy: publicOperation
      ? 'Use this CJS helper as the API wrapper. For public OTC status reads, use run so the helper sends the allowlisted request through the HybridClaw gateway http_request route without credentials.'
      : enterpriseDashboardOperation
        ? 'Use this CJS helper as the API wrapper. For Enterprise Dashboard billing reads, use run so the helper sends the documented bearer-token request through the HybridClaw gateway http_request route.'
        : 'Use this CJS helper as the API wrapper. For live OTC reads, use run so the helper sends the allowlisted request through the HybridClaw gateway http_request route with gateway-managed OTC AK/SK signing.',
    secretRefPolicy: publicOperation
      ? 'This operation does not require OTC credentials. Do not add signing material or secret headers to the public status-dashboard request.'
      : enterpriseDashboardOperation
        ? 'Do not preflight, inspect, print, or ask the model for OTC_ENTERPRISE_DASHBOARD_TOKEN. The bearerSecretName field is a credential reference resolved by the gateway.'
        : 'Do not preflight, inspect, print, or ask the model for OTC_ACCESS_KEY_ID, OTC_SECRET_ACCESS_KEY, OTC_PROJECT_ID, or OTC_SECURITY_TOKEN. The otcAkSk and <secret:...> fields are credential references. OTC_REGION is plain configuration, not signing material.',
    requestShape: enterpriseDashboardOperation
      ? `Operation ${operation} uses the documented Enterprise Dashboard v2 consumption API. Responses are NDJSON; parse each line and sum amount fields for totals.`
      : `Operation ${operation} is allowlisted. Do not handcraft OTC API calls or expose arbitrary service/path passthrough in v1.`,
    unauthorizedPolicy: enterpriseDashboardOperation
      ? 'If a live billing call returns 401 or 403, stop after the first failure and ask the operator to verify Enterprise Dashboard API access, token validity, organization permissions, and token security level.'
      : 'If a live call returns 401, 403, or a signature error, stop after the first failure and ask the operator to verify OTC credential, project, region, IAM, and signing setup.',
    rateLimitPolicy:
      'If a live call returns 429, report the rate limit and include Retry-After or rate-limit response headers when present.',
  };
}

function buildPlan(args = []) {
  const planArgs = [...args];
  const common = readCommonFlags(planArgs);
  const text = planArgs.join(' ');
  const normalized = String(text || '').toLowerCase();
  let operation = null;
  if (ACCOUNT_BILLING_KEYWORDS.test(normalized)) {
    operation = /\b(hourly|hour|stunde|stunden)\b/i.test(normalized)
      ? 'billing-hourly-consumption'
      : 'billing-daily-consumption';
  } else if (WRITE_KEYWORDS.test(normalized))
    operation = 'guarded-mutation-request';
  else if (
    /\b(status dashboard|service status|outage|availability status|platform status)\b/.test(
      normalized,
    )
  )
    operation = 'service-status';
  else if (
    /\b(endpoint|service catalog|api catalog|service list)\b/.test(normalized)
  )
    operation = 'service-endpoints';
  else if (/\b(region|availability zone|az)\b/.test(normalized))
    operation = 'regions';
  else if (/\b(project|tenant)\b/.test(normalized)) operation = 'projects';
  else if (/\b(quota|limit|capacity)\b/.test(normalized)) operation = 'quotas';
  else if (/\b(vpc|network)\b/.test(normalized)) operation = 'networks';
  else if (/\b(subnet)\b/.test(normalized)) operation = 'subnets';
  else if (/\b(security group|firewall rule)\b/.test(normalized))
    operation = 'security-groups';
  else if (/\b(eip|elastic ip|public ip)\b/.test(normalized))
    operation = 'eips';
  else if (/\b(load balancer|elb)\b/.test(normalized))
    operation = 'load-balancers';
  else if (/\b(volume|evs|disk)\b/.test(normalized)) operation = 'volumes';
  else if (/\b(snapshot)\b/.test(normalized)) operation = 'snapshots';
  else if (/\b(backup|cbr)\b/.test(normalized)) operation = 'backups';
  else if (/\b(obs|bucket|object storage)\b/.test(normalized))
    operation = 'obs-bucket';
  else if (/\b(sfs|file share|nfs)\b/.test(normalized))
    operation = 'sfs-shares';
  else if (/\b(cce|kubernetes|cluster|node pool|container)\b/.test(normalized))
    operation = 'cce-clusters';
  else if (/\b(rds|database|postgres|mysql|sqlserver)\b/.test(normalized))
    operation = 'rds-instances';
  else if (/\b(alarm|cloud eye|metric)\b/.test(normalized))
    operation = 'cloud-eye-alarms';
  else if (/\b(trace|audit|cts|cloud trace)\b/.test(normalized))
    operation = 'traces';
  else if (/\b(log|lts|log tank)\b/.test(normalized)) operation = 'log-groups';
  else if (/\b(kms|key)\b/.test(normalized)) operation = 'kms-keys';
  else if (/\b(waf|web application firewall)\b/.test(normalized))
    operation = 'waf-policies';
  else operation = 'unrecognized-request';

  const stakesTier =
    operation === 'guarded-mutation-request'
      ? 'red'
      : operation === 'unrecognized-request'
        ? 'amber'
        : operation.startsWith('billing-')
          ? 'amber'
          : 'green';
  const requiresEscalation = stakesTier === 'red';
  return {
    command: 'plan',
    operation,
    stakesTier,
    requiresEscalation,
    requiredGrant:
      stakesTier === 'red'
        ? 'approve-t-cloud-public-exact-f8-f14-mutation'
        : null,
    region: common.region,
    projectId: common.projectId
      ? 'provided'
      : `<secret:${common.projectIdSecretName}>`,
    nextStep:
      operation === 'unrecognized-request'
        ? 'Ask for the target OTC service, region, project, and desired read-only inventory or readiness check before building an API request.'
        : operation.startsWith('billing-')
          ? `Build a dry-run payload with http-request ${operation}. Use run for live billing reads through the documented Enterprise Dashboard API, then parse NDJSON rows and sum amount fields for the requested period.`
          : stakesTier === 'green'
            ? `Build a dry-run payload with http-request ${operation}.`
            : 'Do not build a write request in v1. Collect exact region, project, service, resource id, action, rollback, and F8/F14 operator approval.',
    secretPolicy: {
      accessKeyIdSecretName: common.accessKeyIdSecretName,
      secretAccessKeySecretName: common.secretAccessKeySecretName,
      projectIdSecretName: common.projectIdSecretName,
      enterpriseDashboardTokenSecretName:
        common.enterpriseDashboardTokenSecretName,
      modelSeesSecrets: false,
    },
    costMeasurement: COST_MEASUREMENT,
  };
}

function summarizeResponse(response, operation) {
  const enterpriseDashboardOperation =
    OPERATION_DEFS[operation]?.auth === 'bearer';
  const status = Number(response?.status || 0);
  const headers =
    response?.headers && typeof response.headers === 'object'
      ? Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        )
      : {};
  const bodyText = typeof response?.body === 'string' ? response.body : '';
  const credentialProblem =
    status === 401 ||
    status === 403 ||
    /signature|credential|unauthorized|forbidden/i.test(bodyText);
  const rateLimited = status === 429;
  return {
    credentialProblem,
    rateLimited,
    guidance: credentialProblem
      ? enterpriseDashboardOperation
        ? 'Stop after this failed Enterprise Dashboard billing call. Verify OTC_ENTERPRISE_DASHBOARD_TOKEN, token validity, organization permissions, product tier with API access, and token security level.'
        : 'Stop after this failed OTC call. Verify OTC_ACCESS_KEY_ID, OTC_SECRET_ACCESS_KEY, OTC_PROJECT_ID, selected region, IAM permissions, clock skew, and endpoint region.'
      : rateLimited
        ? 'Stop fan-out and retry later using Retry-After or rate-limit response headers when available.'
        : null,
    retryAfter: headers['retry-after'] || headers['x-ratelimit-reset'] || null,
  };
}

function summarizeBillingResponse(response) {
  const bodyText = typeof response?.body === 'string' ? response.body : '';
  const summary = {
    rowCount: 0,
    amountTotal: 0,
    skippedRows: 0,
    products: {},
  };
  for (const line of bodyText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      summary.skippedRows += 1;
      continue;
    }
    summary.rowCount += 1;
    const amount = Number(row.amount);
    if (Number.isFinite(amount)) {
      summary.amountTotal += amount;
      const product =
        String(row.product_description || row.product || 'unknown').trim() ||
        'unknown';
      summary.products[product] = (summary.products[product] || 0) + amount;
    }
  }
  summary.amountTotal = Number(summary.amountTotal.toFixed(12));
  summary.products = Object.fromEntries(
    Object.entries(summary.products)
      .sort((left, right) => right[1] - left[1])
      .map(([key, value]) => [key, Number(value.toFixed(12))]),
  );
  return summary;
}

async function gatewayRequest(httpRequest, { gatewayUrl, gatewayToken }) {
  try {
    return await executeSharedGatewayRequest(httpRequest, {
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      gatewayToken,
      gatewayUrl,
      normalize: false,
      serviceName: 'T-Cloud Public',
    });
  } catch (error) {
    die(error instanceof Error ? error.message : String(error), 1);
  }
}

async function commandRun(args) {
  const gatewayUrl = resolveGatewayUrl(popFlag(args, '--gateway-url'));
  const gatewayToken = resolveGatewayToken(popFlag(args, '--gateway-token'), {
    gatewayTokenEnvNames: GATEWAY_TOKEN_ENV_NAMES,
  });
  const payload = commandHttpRequest(args);
  const response = await gatewayRequest(payload.httpRequest, {
    gatewayUrl,
    gatewayToken,
  });
  const responseSummary = summarizeResponse(response, payload.operation);
  return {
    command: 'run',
    operation: payload.operation,
    stakesTier: payload.stakesTier,
    response,
    responseSummary,
    ...(payload.operation.startsWith('billing-')
      ? { billingSummary: summarizeBillingResponse(response) }
      : {}),
    costMeasurement: COST_MEASUREMENT,
    liveExecution: payload.liveExecution,
  };
}

function commandHttpRequest(args) {
  const operation = args.shift();
  if (!operation) die('http-request requires an operation.');
  if (!READ_OPERATIONS.has(operation)) {
    die(`Unknown T Cloud Public / Open Telekom Cloud operation: ${operation}`);
  }
  return buildHttpRequest(operation, args);
}

function commandEvalScenarios() {
  const scenarios = JSON.parse(fs.readFileSync(EVAL_SCENARIOS_PATH, 'utf-8'));
  const categories = {};
  let failed = 0;
  for (const scenario of scenarios) {
    categories[scenario.category] = (categories[scenario.category] || 0) + 1;
    if (
      !scenario.expectedOperation ||
      !scenario.expectedTier ||
      scenario.costMeasurement?.system !== 'UsageTotals'
    ) {
      failed += 1;
    }
  }
  return {
    command: 'eval-scenarios',
    scenarioCount: scenarios.length,
    failed,
    categories,
    scenarios,
    costMeasurement: COST_MEASUREMENT,
  };
}

function printOutput(payload, format) {
  if (format === 'json') {
    printJson(payload);
    return;
  }
  if (format === 'text') {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  die('--format must be json or text.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    showHelp();
    return;
  }
  const format = popFlag(args, '--format', 'text');
  const command = args.shift();
  let payload;
  if (command === 'plan') {
    payload = buildPlan(args);
  } else if (command === 'http-request') {
    payload = commandHttpRequest(args);
  } else if (command === 'run') {
    payload = await commandRun(args);
  } else if (command === 'eval-scenarios') {
    payload = commandEvalScenarios();
  } else {
    die(`Unknown command: ${command}`);
  }
  printOutput(payload, format);
}

function showHelp() {
  process.stdout.write(`T Cloud Public (formerly Open Telekom Cloud) skill helper

Usage:
  node skills/t-cloud-public/t_cloud_public.cjs [--format json] plan <request> [--region eu-de]
  node skills/t-cloud-public/t_cloud_public.cjs [--format json] http-request <operation> [flags]
  node skills/t-cloud-public/t_cloud_public.cjs [--format json] run <operation> [flags]
  node skills/t-cloud-public/t_cloud_public.cjs [--format json] eval-scenarios

Common flags:
  --region eu-de
  --project-id <project-id>                Optional; otherwise emits <secret:OTC_PROJECT_ID>
  --project-id-secret OTC_PROJECT_ID
  --access-key-id-secret OTC_ACCESS_KEY_ID
  --secret-access-key-secret OTC_SECRET_ACCESS_KEY
  --security-token-secret OTC_SECURITY_TOKEN
  --enterprise-dashboard-token-secret OTC_ENTERPRISE_DASHBOARD_TOKEN

Read operations:
  regions
  projects [--name name]
  service-endpoints [--service-id id] [--interface public] [--region eu-de] [--enabled true]
  services [--name name] [--type compute]
  service-status
  billing-daily-consumption [--date YYYY-MM-DD] [--project-name eu-de] [--consumption-type EL|RC]
  billing-hourly-consumption [--date YYYY-MM-DD] [--hour 0-23] [--project-name eu-de]
  quotas --region eu-de [--project-id id]
  servers --region eu-de [--limit 50] [--name name] [--status ACTIVE]
  server --server-id id
  flavors [--limit 50]
  networks|vpcs [--limit 50]
  subnets [--vpc-id id]
  security-groups [--vpc-id id]
  eips [--limit 50]
  load-balancers [--limit 50]
  volumes [--limit 50] [--name name] [--status available]
  snapshots [--limit 50] [--volume-id id]
  backups [--limit 50] [--resource-id id]
  sfs-shares [--limit 50]
  obs-bucket --bucket name [--prefix path/] [--max-keys 50]
  cce-clusters
  cce-nodes --cluster-id id
  rds-instances [--limit 50] [--name name] [--datastore-type PostgreSQL]
  cloud-eye-alarms [--limit 50] [--alarm-state ok|alarm]
  traces [--limit 50] [--service-type ECS]
  log-groups [--limit 50]
  kms-keys [--limit 50]
  waf-policies [--page 1] [--pagesize 50]

Examples:
  node skills/t-cloud-public/t_cloud_public.cjs --format json http-request regions
  node skills/t-cloud-public/t_cloud_public.cjs --format json http-request quotas --region eu-de
  node skills/t-cloud-public/t_cloud_public.cjs --format json http-request servers --region eu-de --limit 50
  node skills/t-cloud-public/t_cloud_public.cjs --format json http-request networks --region eu-de --limit 50
  node skills/t-cloud-public/t_cloud_public.cjs --format json http-request volumes --region eu-de --limit 50
  node skills/t-cloud-public/t_cloud_public.cjs --format json http-request cloud-eye-alarms --region eu-de --limit 50
  node skills/t-cloud-public/t_cloud_public.cjs --format json http-request billing-daily-consumption --date ${todayLocalIsoDate()}
  node skills/t-cloud-public/t_cloud_public.cjs --format json plan deploy-check --region eu-de --project-id <project-id>

V1 is read/list/describe only. Mutating OTC actions require exact F8/F14
approval and are intentionally planned, not executed, by this helper.
`);
}

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error), 1);
});
