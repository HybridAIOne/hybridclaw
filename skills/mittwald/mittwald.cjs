#!/usr/bin/env node
'use strict';

const API_BASE = 'https://api.mittwald.de/v2';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SECRET_NAME = 'MITTWALD_API_TOKEN';
const COST_MEASUREMENT = {
  system: 'UsageTotals',
  subLimitKey: 'mittwald',
};

const LIVE_EXECUTION = {
  mode: 'live-mittwald-api',
  requiresConfiguredSecrets: [SECRET_NAME],
  dryRunSafe:
    'For prompt/user testing, stop after producing this payload; do not call http_request.',
  callPolicy:
    'For live mittwald reads, pass the emitted httpRequest object unchanged to http_request so the gateway injects the bearer token server-side.',
  secretRefPolicy:
    'Do not preflight, inspect, print, or ask the model for MITTWALD_API_TOKEN. bearerSecretName is the credential reference.',
  requestShape:
    'Do not handcraft mittwald API calls. The helper owns endpoint selection, method, payload, stakes tier, and bearerSecretName.',
  unauthorizedPolicy:
    'If a live call returns 401 or 403, stop after the first failure. Do not retry or call additional mittwald endpoints; ask the operator to set or verify MITTWALD_API_TOKEN.',
  rateLimitPolicy:
    'If a live call returns 429, stop and report retry guidance from Retry-After or X-RateLimit-Reset headers when present.',
};

const OPERATION_TIERS = {
  whoami: 'green',
  projects: 'green',
  project: 'green',
  apps: 'green',
  app: 'green',
  'app-status': 'green',
  'app-system-software': 'green',
  databases: 'green',
  'mysql-databases': 'green',
  'redis-databases': 'green',
  domains: 'green',
  'dns-zones': 'green',
  ingresses: 'green',
  backups: 'green',
  'backup-path': 'green',
  'backup-database-dumps': 'green',
  cronjobs: 'green',
  'ssh-users': 'green',
  'sftp-users': 'green',
  'mail-addresses': 'green',
  'delivery-boxes': 'green',
  'mail-settings': 'green',
  stacks: 'green',
  services: 'green',
  volumes: 'green',
  registries: 'green',
  'service-logs': 'green',
  'file-info': 'green',
  directory: 'green',
  'disk-usage': 'green',
  'extension-orders': 'green',
  'extension-instances': 'green',
  'extension-instance': 'green',
  licenses: 'green',
  domain: 'green',
  backup: 'green',
  service: 'green',
  'create-redis-database': 'amber',
  'create-mysql-database': 'amber',
  'create-app-installation': 'amber',
  'create-cronjob': 'amber',
  'change-domain-project': 'amber',
  'update-domain-nameservers': 'amber',
  'cancel-domain-deletion': 'amber',
  'check-domain-availability': 'amber',
  'validate-license-key': 'amber',
  'create-delivery-box': 'amber',
  'app-action': 'red',
  'service-action': 'red',
  'order-extension': 'red',
  'restore-backup': 'red',
  'restore-backup-path': 'red',
  'schedule-domain-deletion': 'red',
};
const HTTP_OPERATIONS = new Set(Object.keys(OPERATION_TIERS));
const APP_ACTIONS = new Set(['start', 'stop', 'restart']);
const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart']);

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function popFlag(args, name, defaultValue) {
  const index = args.indexOf(name);
  if (index === -1) return defaultValue;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    die(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function popBooleanFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
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

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    die(`${label} is required.`);
  }
  return value.trim();
}

function encodeSegment(value, label) {
  return encodeURIComponent(requireText(value, label));
}

function parseInteger(value, label, { min, max } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    die(`${label} must be an integer.`);
  }
  if (min !== undefined && number < min) {
    die(`${label} must be at least ${min}.`);
  }
  if (max !== undefined && number > max) {
    die(`${label} must be at most ${max}.`);
  }
  return number;
}

function parseLimit(args, { defaultLimit = DEFAULT_LIMIT } = {}) {
  const raw = popFlag(args, '--limit', String(defaultLimit));
  return parseInteger(raw, '--limit', { min: 1, max: MAX_LIMIT });
}

function parseOptionalPageArgs(args, query) {
  const page = popFlag(args, '--page');
  const skip = popFlag(args, '--skip');
  if (page !== undefined) {
    query.page = parseInteger(page, '--page', { min: 1 });
  }
  if (skip !== undefined) {
    query.skip = parseInteger(skip, '--skip', { min: 0 });
  }
}

function appendQuery(url, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function parseJsonFlag(args, name) {
  const raw = popFlag(args, name);
  if (raw === undefined) die(`${name} is required.`);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      die(`${name} must be a JSON object.`);
    }
    return parsed;
  } catch (error) {
    die(`Could not parse ${name}: ${error.message}`);
  }
}

function secretPlaceholder(args, flag) {
  const secretName = requireText(popFlag(args, flag), flag);
  if (!/^[A-Z0-9_]+$/.test(secretName)) {
    die(`${flag} must be an uppercase store secret id such as MYSQL_PASSWORD.`);
  }
  return `<secret:${secretName}>`;
}

function requireGrant(args, operation, target) {
  if (!popBooleanFlag(args, '--operator-grant')) {
    die(
      `${operation} requires exact F8/F14 operator approval for target ${target}. Rerun with --operator-grant only after approval.`,
    );
  }
  return {
    route: 'f14',
    requiredGrant: `approve-mittwald-${operation}:${target}`,
    target,
    text: `Approve mittwald ${operation} for ${target}`,
  };
}

function wrapHttpRequest(operation, { url, method = 'GET', json, headers }) {
  const tier = OPERATION_TIERS[operation];
  const httpRequest = {
    url,
    method,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    bearerSecretName: SECRET_NAME,
    skillName: 'mittwald',
    stakesTier: tier,
  };
  if (headers !== undefined) httpRequest.headers = headers;
  if (json !== undefined) httpRequest.json = json;
  return {
    command: 'http-request',
    operation,
    stakesTier: tier,
    httpRequest,
    costMeasurement: COST_MEASUREMENT,
    liveExecution: LIVE_EXECUTION,
  };
}

function wrapMutation(operation, request, approval, followUp) {
  const payload = wrapHttpRequest(operation, request);
  payload.approval = approval;
  payload.eventConsistency = {
    responseEventHeader: 'etag',
    requestHeader: 'if-event-reached',
    followUp,
    guidance:
      'After the live http_request returns an etag header, run the follow-up command with --event-id <etag> before reporting completion.',
  };
  return payload;
}

function wrapHttpRequests(operation, requests, extra = {}) {
  return {
    command: 'http-request',
    operation,
    stakesTier: OPERATION_TIERS[operation],
    httpRequests: requests.map((request) => request.httpRequest),
    costMeasurement: COST_MEASUREMENT,
    liveExecution: LIVE_EXECUTION,
    ...extra,
  };
}

function projectId(args) {
  return encodeSegment(popFlag(args, '--project-id'), '--project-id');
}

function appId(args) {
  return encodeSegment(
    popFlag(args, '--app-installation-id') || popFlag(args, '--app-id'),
    '--app-installation-id',
  );
}

function backupId(args) {
  return encodeSegment(popFlag(args, '--backup-id'), '--backup-id');
}

function domainId(args) {
  return encodeSegment(popFlag(args, '--domain-id'), '--domain-id');
}

function stackAndService(args) {
  return {
    stack: encodeSegment(popFlag(args, '--stack-id'), '--stack-id'),
    service: encodeSegment(popFlag(args, '--service-id'), '--service-id'),
  };
}

function assertAllowedAction(action, allowed, label) {
  const normalized = requireText(action, label);
  if (!allowed.has(normalized)) {
    die(`${label} must be one of: ${[...allowed].join(', ')}.`);
  }
  return normalized;
}

function listQuery(args, allowed = {}) {
  const query = { limit: parseLimit(args) };
  parseOptionalPageArgs(args, query);
  for (const [flag, key] of Object.entries(allowed)) {
    const value = popFlag(args, flag);
    if (value !== undefined) query[key] = value;
  }
  return query;
}

function commandHttpRequest(args) {
  const operation = args.shift();
  if (!operation) die('http-request requires an operation.');
  if (!HTTP_OPERATIONS.has(operation)) {
    die(`Unknown mittwald http-request operation: ${operation}`);
  }

  let payload;
  switch (operation) {
    case 'whoami':
      payload = wrapHttpRequest(operation, { url: `${API_BASE}/user` });
      break;
    case 'projects': {
      const query = listQuery(args, {
        '--customer-id': 'customerId',
        '--server-id': 'serverId',
        '--search-term': 'searchTerm',
        '--sort': 'sort',
        '--order': 'order',
      });
      payload = wrapHttpRequest(operation, {
        url: appendQuery(`${API_BASE}/projects`, query),
      });
      break;
    }
    case 'project':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/projects/${projectId(args)}`,
      });
      break;
    case 'apps': {
      const project = projectId(args);
      const query = listQuery(args, {
        '--search-term': 'searchTerm',
        '--sort-order': 'sortOrder',
      });
      payload = wrapHttpRequest(operation, {
        url: appendQuery(
          `${API_BASE}/projects/${project}/app-installations`,
          query,
        ),
      });
      break;
    }
    case 'app':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/app-installations/${appId(args)}`,
      });
      break;
    case 'app-status':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/app-installations/${appId(args)}/status`,
      });
      break;
    case 'app-system-software': {
      const app = appId(args);
      const tagFilter = popFlag(args, '--tag-filter');
      payload = wrapHttpRequest(operation, {
        url: appendQuery(
          `${API_BASE}/app-installations/${app}/systemSoftware`,
          {
            tagFilter,
          },
        ),
      });
      break;
    }
    case 'databases': {
      const project = projectId(args);
      const mysql = wrapHttpRequest('mysql-databases', {
        url: `${API_BASE}/projects/${project}/mysql-databases`,
      });
      const redis = wrapHttpRequest('redis-databases', {
        url: `${API_BASE}/projects/${project}/redis-databases`,
      });
      payload = wrapHttpRequests(operation, [mysql, redis], {
        note: 'Pass each httpRequests item to http_request, then merge MySQL and Redis results in the answer.',
      });
      break;
    }
    case 'mysql-databases':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/projects/${projectId(args)}/mysql-databases`,
      });
      break;
    case 'redis-databases':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/projects/${projectId(args)}/redis-databases`,
      });
      break;
    case 'domains': {
      const project = projectId(args);
      const query = listQuery(args, {
        '--domain-search-name': 'domainSearchName',
      });
      payload = wrapHttpRequest(operation, {
        url: appendQuery(`${API_BASE}/projects/${project}/domains`, query),
      });
      break;
    }
    case 'dns-zones':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/projects/${projectId(args)}/dns-zones`,
      });
      break;
    case 'ingresses':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/projects/${projectId(args)}/ingresses`,
      });
      break;
    case 'backups': {
      const project = projectId(args);
      const query = listQuery(args, {
        '--search-term': 'searchTerm',
        '--sort-order': 'sortOrder',
      });
      const withExportsOnly = popBooleanFlag(args, '--with-exports-only');
      const runningRestoresOnly = popBooleanFlag(
        args,
        '--running-restores-only',
      );
      const runningBackupsOnly = popBooleanFlag(args, '--running-backups-only');
      payload = wrapHttpRequest(operation, {
        url: appendQuery(`${API_BASE}/projects/${project}/backups`, {
          ...query,
          withExportsOnly,
          runningRestoresOnly,
          runningBackupsOnly,
        }),
      });
      break;
    }
    case 'backup-path': {
      const backup = backupId(args);
      const path = popFlag(args, '--path');
      payload = wrapHttpRequest(operation, {
        url: appendQuery(`${API_BASE}/project-backups/${backup}/path`, {
          path,
        }),
      });
      break;
    }
    case 'backup-database-dumps':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/project-backups/${backupId(args)}/database-dumps`,
      });
      break;
    case 'cronjobs': {
      const project = projectId(args);
      const query = listQuery(args);
      const includeServiceCronjobs = popBooleanFlag(
        args,
        '--include-service-cronjobs',
      );
      payload = wrapHttpRequest(operation, {
        url: appendQuery(`${API_BASE}/projects/${project}/cronjobs`, {
          ...query,
          includeServiceCronjobs,
        }),
      });
      break;
    }
    case 'ssh-users':
    case 'sftp-users': {
      const project = projectId(args);
      const query = { limit: parseLimit(args) };
      const skip = popFlag(args, '--skip');
      if (skip !== undefined)
        query.skip = parseInteger(skip, '--skip', { min: 0 });
      payload = wrapHttpRequest(operation, {
        url: appendQuery(`${API_BASE}/projects/${project}/${operation}`, query),
      });
      break;
    }
    case 'mail-addresses': {
      const project = projectId(args);
      const query = listQuery(args, { '--search': 'search' });
      payload = wrapHttpRequest(operation, {
        url: appendQuery(
          `${API_BASE}/projects/${project}/mail-addresses`,
          query,
        ),
      });
      break;
    }
    case 'delivery-boxes': {
      const project = projectId(args);
      const query = listQuery(args);
      payload = wrapHttpRequest(operation, {
        url: appendQuery(
          `${API_BASE}/projects/${project}/delivery-boxes`,
          query,
        ),
      });
      break;
    }
    case 'mail-settings':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/projects/${projectId(args)}/mail-settings`,
      });
      break;
    case 'stacks':
    case 'services':
    case 'volumes': {
      const project = projectId(args);
      const query = listQuery(args, {
        '--search-term': 'searchTerm',
        '--sort-order': 'sortOrder',
        '--stack-id': 'stackId',
        '--status': 'status',
      });
      payload = wrapHttpRequest(operation, {
        url: appendQuery(`${API_BASE}/projects/${project}/${operation}`, query),
      });
      break;
    }
    case 'registries':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/projects/${projectId(args)}/registries`,
      });
      break;
    case 'service-logs': {
      const stack = encodeSegment(popFlag(args, '--stack-id'), '--stack-id');
      const service = encodeSegment(
        popFlag(args, '--service-id'),
        '--service-id',
      );
      const tail = popFlag(args, '--tail', '200');
      payload = wrapHttpRequest(operation, {
        url: appendQuery(
          `${API_BASE}/stacks/${stack}/services/${service}/logs`,
          {
            tail: parseInteger(tail, '--tail', { min: 1, max: 2_000 }),
          },
        ),
      });
      break;
    }
    case 'file-info': {
      const project = projectId(args);
      const file = requireText(popFlag(args, '--file'), '--file');
      payload = wrapHttpRequest(operation, {
        url: appendQuery(`${API_BASE}/projects/${project}/filesystem/files`, {
          file,
        }),
      });
      break;
    }
    case 'directory': {
      const project = projectId(args);
      const directory = requireText(
        popFlag(args, '--directory'),
        '--directory',
      );
      const maxDepth = popFlag(args, '--max-depth', '1');
      payload = wrapHttpRequest(operation, {
        url: appendQuery(
          `${API_BASE}/projects/${project}/filesystem/directories`,
          {
            directory,
            max_depth: parseInteger(maxDepth, '--max-depth', {
              min: 0,
              max: 5,
            }),
            name: popFlag(args, '--name'),
          },
        ),
      });
      break;
    }
    case 'disk-usage': {
      const project = projectId(args);
      const directory = popFlag(args, '--directory');
      payload = wrapHttpRequest(operation, {
        url: appendQuery(
          `${API_BASE}/projects/${project}/filesystem/usages/disk`,
          {
            directory,
          },
        ),
      });
      break;
    }
    case 'extension-orders':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/projects/${projectId(args)}/extension-orders`,
      });
      break;
    case 'extension-instances': {
      const query = listQuery(args, {
        '--context': 'context',
        '--context-id': 'contextId',
        '--extension-id': 'extensionId',
        '--search-term': 'searchTerm',
      });
      payload = wrapHttpRequest(operation, {
        url: appendQuery(`${API_BASE}/extension-instances`, query),
      });
      break;
    }
    case 'extension-instance':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/extension-instances/${encodeSegment(
          popFlag(args, '--extension-instance-id'),
          '--extension-instance-id',
        )}`,
      });
      break;
    case 'licenses':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/projects/${projectId(args)}/licenses`,
      });
      break;
    case 'domain':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/domains/${domainId(args)}`,
      });
      break;
    case 'backup':
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/project-backups/${backupId(args)}`,
      });
      break;
    case 'service': {
      const { stack, service } = stackAndService(args);
      payload = wrapHttpRequest(operation, {
        url: `${API_BASE}/stacks/${stack}/services/${service}`,
      });
      break;
    }
    case 'create-redis-database': {
      const project = projectId(args);
      const description = requireText(
        popFlag(args, '--description'),
        '--description',
      );
      const version = requireText(popFlag(args, '--version'), '--version');
      const target = `project:${project} redis:${description}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/projects/${project}/redis-databases`,
          method: 'POST',
          json: { description, version },
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --project-id ${project} --event-id <etag>`,
          verifies: 'redis database appears in project database inventory',
        },
      );
      break;
    }
    case 'create-mysql-database': {
      const project = projectId(args);
      const description = requireText(
        popFlag(args, '--description'),
        '--description',
      );
      const version = requireText(popFlag(args, '--version'), '--version');
      const password = secretPlaceholder(args, '--password-secret');
      const externalAccess = popBooleanFlag(args, '--external-access');
      const target = `project:${project} mysql:${description}`;
      const user = { accessLevel: 'full', password };
      if (externalAccess !== undefined) user.externalAccess = true;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/projects/${project}/mysql-databases`,
          method: 'POST',
          json: {
            database: { description, version },
            user,
          },
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --project-id ${project} --event-id <etag>`,
          verifies: 'MySQL database appears in project database inventory',
        },
      );
      break;
    }
    case 'create-app-installation': {
      const project = projectId(args);
      const json = parseJsonFlag(args, '--body-json');
      const target = `project:${project} appVersion:${json.appVersionId || 'unknown'}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/projects/${project}/app-installations`,
          method: 'POST',
          json,
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --project-id ${project} --event-id <etag>`,
          verifies: 'app installation appears in project app list',
        },
      );
      break;
    }
    case 'create-cronjob': {
      const project = projectId(args);
      const json = parseJsonFlag(args, '--body-json');
      const target = `project:${project} cronjob:${json.description || json.interval || 'new'}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/projects/${project}/cronjobs`,
          method: 'POST',
          json,
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --project-id ${project} --event-id <etag>`,
          verifies: 'cronjob appears in project cronjob list',
        },
      );
      break;
    }
    case 'app-action': {
      const app = appId(args);
      const action = assertAllowedAction(
        popFlag(args, '--action'),
        APP_ACTIONS,
        '--action',
      );
      const target = `app-installation:${app} action:${action}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/app-installations/${app}/actions/${action}`,
          method: 'POST',
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --app-installation-id ${app} --event-id <etag>`,
          verifies: 'app runtime status reflects requested action',
        },
      );
      break;
    }
    case 'service-action': {
      const { stack, service } = stackAndService(args);
      const action = assertAllowedAction(
        popFlag(args, '--action'),
        SERVICE_ACTIONS,
        '--action',
      );
      const target = `stack:${stack} service:${service} action:${action}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/stacks/${stack}/services/${service}/actions/${action}`,
          method: 'POST',
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --stack-id ${stack} --service-id ${service} --event-id <etag>`,
          verifies: 'service status reflects requested action',
        },
      );
      break;
    }
    case 'change-domain-project': {
      const domain = domainId(args);
      const nextProject = requireText(
        popFlag(args, '--target-project-id'),
        '--target-project-id',
      );
      const target = `domain:${domain} target-project:${nextProject}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/domains/${domain}/project-id`,
          method: 'PATCH',
          json: { projectId: nextProject },
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --domain-id ${domain} --event-id <etag>`,
          verifies: 'domain project id matches target project',
        },
      );
      break;
    }
    case 'update-domain-nameservers': {
      const domain = domainId(args);
      const nameservers = popRepeatedFlag(args, '--nameserver');
      if (nameservers.length < 2) {
        die(
          'update-domain-nameservers requires at least two --nameserver values.',
        );
      }
      const target = `domain:${domain} nameservers:${nameservers.join(',')}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/domains/${domain}/nameservers`,
          method: 'PATCH',
          json: { nameservers },
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --domain-id ${domain} --event-id <etag>`,
          verifies: 'domain nameservers match requested set',
        },
      );
      break;
    }
    case 'schedule-domain-deletion': {
      const domain = domainId(args);
      const deletionDate = requireText(
        popFlag(args, '--deletion-date'),
        '--deletion-date',
      );
      const deleteIngresses =
        popBooleanFlag(args, '--delete-ingresses') === true;
      const target = `domain:${domain} deletion-date:${deletionDate}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/domains/${domain}/scheduled-deletion`,
          method: 'POST',
          json: { deletionDate, deleteIngresses },
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --domain-id ${domain} --event-id <etag>`,
          verifies: 'domain scheduled deletion is visible',
        },
      );
      break;
    }
    case 'cancel-domain-deletion': {
      const domain = domainId(args);
      const target = `domain:${domain} scheduled-deletion`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/domains/${domain}/scheduled-deletion`,
          method: 'DELETE',
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --domain-id ${domain} --event-id <etag>`,
          verifies: 'domain scheduled deletion is absent',
        },
      );
      break;
    }
    case 'check-domain-availability': {
      const domain = requireText(popFlag(args, '--domain'), '--domain');
      const target = `domain:${domain}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/domains`,
          method: 'POST',
          json: { domain },
        },
        requireGrant(args, operation, target),
        {
          command: null,
          verifies:
            'availability check response is reviewed; no follow-up read is required',
        },
      );
      break;
    }
    case 'restore-backup': {
      const backup = backupId(args);
      const json = parseJsonFlag(args, '--body-json');
      const target = `project-backup:${backup}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/project-backups/${backup}/restore`,
          method: 'POST',
          json,
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --backup-id ${backup} --event-id <etag>`,
          verifies: 'backup restore status is visible on the backup',
        },
      );
      break;
    }
    case 'restore-backup-path': {
      const backup = backupId(args);
      const sourcePath = requireText(
        popFlag(args, '--source-path'),
        '--source-path',
      );
      const targetPath = popFlag(args, '--target-path');
      const clearTargetPath =
        popBooleanFlag(args, '--clear-target-path') === true;
      const target = `project-backup:${backup} source:${sourcePath} target:${targetPath || sourcePath}`;
      const json = { sourcePath, clearTargetPath };
      if (targetPath !== undefined) json.targetPath = targetPath;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/project-backups/${backup}/restore-path`,
          method: 'POST',
          json,
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --backup-id ${backup} --event-id <etag>`,
          verifies: 'backup path restore status is visible on the backup',
        },
      );
      break;
    }
    case 'validate-license-key': {
      const project = projectId(args);
      const key = secretPlaceholder(args, '--license-key-secret');
      const kind = requireText(popFlag(args, '--kind'), '--kind');
      const target = `project:${project} license-kind:${kind}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/projects/${project}/actions/validate-license-key`,
          method: 'POST',
          json: { key, kind },
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --project-id ${project} --event-id <etag>`,
          verifies:
            'project licenses reflect validation result when applicable',
        },
      );
      break;
    }
    case 'order-extension': {
      const extension = encodeSegment(
        popFlag(args, '--extension-id'),
        '--extension-id',
      );
      const json = parseJsonFlag(args, '--body-json');
      const target = `extension:${extension} context:${json.projectId || json.customerId || 'unknown'}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/extensions/${extension}/order`,
          method: 'POST',
          json,
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --extension-id ${extension} --event-id <etag>`,
          verifies:
            'extension instance or extension order reflects the marketplace order',
        },
      );
      break;
    }
    case 'create-delivery-box': {
      const project = projectId(args);
      const description = requireText(
        popFlag(args, '--description'),
        '--description',
      );
      const password = secretPlaceholder(args, '--password-secret');
      const target = `project:${project} delivery-box:${description}`;
      payload = wrapMutation(
        operation,
        {
          url: `${API_BASE}/projects/${project}/delivery-boxes`,
          method: 'POST',
          json: { description, password },
        },
        requireGrant(args, operation, target),
        {
          command: `node skills/mittwald/mittwald.cjs --format json event-follow-up ${operation} --project-id ${project} --event-id <etag>`,
          verifies: 'delivery box is visible in project mail resources',
        },
      );
      break;
    }
    default:
      die(`Unknown mittwald operation: ${operation}`);
  }

  assertNoUnexpectedArgs(args);
  return payload;
}

function commandEventFollowUp(args) {
  const operation = args.shift();
  if (!operation) die('event-follow-up requires the original operation.');
  const eventId = requireText(popFlag(args, '--event-id'), '--event-id');
  const headers = { 'if-event-reached': eventId };
  let payload;

  switch (operation) {
    case 'create-redis-database':
    case 'create-mysql-database': {
      const project = projectId(args);
      payload = wrapHttpRequests(operation, [
        wrapHttpRequest('mysql-databases', {
          url: `${API_BASE}/projects/${project}/mysql-databases`,
          headers,
        }),
        wrapHttpRequest('redis-databases', {
          url: `${API_BASE}/projects/${project}/redis-databases`,
          headers,
        }),
      ]);
      break;
    }
    case 'create-app-installation':
      payload = wrapHttpRequest('apps', {
        url: appendQuery(
          `${API_BASE}/projects/${projectId(args)}/app-installations`,
          {
            limit: DEFAULT_LIMIT,
          },
        ),
        headers,
      });
      break;
    case 'create-cronjob':
      payload = wrapHttpRequest('cronjobs', {
        url: appendQuery(`${API_BASE}/projects/${projectId(args)}/cronjobs`, {
          limit: DEFAULT_LIMIT,
        }),
        headers,
      });
      break;
    case 'app-action':
      payload = wrapHttpRequest('app-status', {
        url: `${API_BASE}/app-installations/${appId(args)}/status`,
        headers,
      });
      break;
    case 'service-action': {
      const { stack, service } = stackAndService(args);
      payload = wrapHttpRequest('service', {
        url: `${API_BASE}/stacks/${stack}/services/${service}`,
        headers,
      });
      break;
    }
    case 'change-domain-project':
    case 'update-domain-nameservers':
    case 'schedule-domain-deletion':
    case 'cancel-domain-deletion':
      payload = wrapHttpRequest('domain', {
        url: `${API_BASE}/domains/${domainId(args)}`,
        headers,
      });
      break;
    case 'restore-backup':
    case 'restore-backup-path':
      payload = wrapHttpRequest('backup', {
        url: `${API_BASE}/project-backups/${backupId(args)}`,
        headers,
      });
      break;
    case 'validate-license-key':
      payload = wrapHttpRequest('licenses', {
        url: `${API_BASE}/projects/${projectId(args)}/licenses`,
        headers,
      });
      break;
    case 'order-extension':
      payload = wrapHttpRequest('extension-instances', {
        url: appendQuery(`${API_BASE}/extension-instances`, {
          extensionId: popFlag(args, '--extension-id'),
          limit: DEFAULT_LIMIT,
        }),
        headers,
      });
      break;
    case 'create-delivery-box':
      payload = wrapHttpRequest('delivery-boxes', {
        url: appendQuery(
          `${API_BASE}/projects/${projectId(args)}/delivery-boxes`,
          {
            limit: DEFAULT_LIMIT,
          },
        ),
        headers,
      });
      break;
    default:
      die(`Unsupported event-follow-up operation: ${operation}`);
  }

  assertNoUnexpectedArgs(args);
  payload.command = 'event-follow-up';
  payload.originalOperation = operation;
  payload.eventConsistency = {
    requestHeader: 'if-event-reached',
    eventId,
  };
  return payload;
}

function commandPlan(args) {
  const plan = args.shift();
  if (plan !== 'deploy-check') {
    die('plan requires a supported plan name: deploy-check.');
  }
  const project = requireText(popFlag(args, '--project-id'), '--project-id');
  assertNoUnexpectedArgs(args);
  return {
    command: 'plan',
    plan,
    projectId: project,
    stakesTier: 'green',
    requiredGrant: null,
    costMeasurement: COST_MEASUREMENT,
    secretPolicy: {
      bearerSecretName: SECRET_NAME,
      modelSeesToken: false,
    },
    steps: [
      {
        operation: 'project',
        command: `node skills/mittwald/mittwald.cjs --format json http-request project --project-id ${project}`,
      },
      {
        operation: 'apps',
        command: `node skills/mittwald/mittwald.cjs --format json http-request apps --project-id ${project} --limit ${DEFAULT_LIMIT}`,
      },
      {
        operation: 'databases',
        command: `node skills/mittwald/mittwald.cjs --format json http-request databases --project-id ${project}`,
      },
      {
        operation: 'domains',
        command: `node skills/mittwald/mittwald.cjs --format json http-request domains --project-id ${project} --limit ${DEFAULT_LIMIT}`,
      },
      {
        operation: 'ingresses',
        command: `node skills/mittwald/mittwald.cjs --format json http-request ingresses --project-id ${project}`,
      },
      {
        operation: 'cronjobs',
        command: `node skills/mittwald/mittwald.cjs --format json http-request cronjobs --project-id ${project} --limit ${DEFAULT_LIMIT}`,
      },
      {
        operation: 'backups',
        command: `node skills/mittwald/mittwald.cjs --format json http-request backups --project-id ${project} --limit ${DEFAULT_LIMIT}`,
      },
      {
        operation: 'services',
        command: `node skills/mittwald/mittwald.cjs --format json http-request services --project-id ${project} --limit ${DEFAULT_LIMIT}`,
      },
    ],
    guidance:
      'Execute the generated read requests through http_request, stop on the first 401/403, and summarize readiness, drift, failed app phases, runtime states, ingress/domain/DNS health, stale backups, cron failures, and container service status.',
  };
}

function normalizeHeaders(headersJson) {
  if (!headersJson) return {};
  try {
    const parsed = JSON.parse(headersJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      die('--headers-json must be a JSON object.');
    }
    const normalized = {};
    for (const [key, value] of Object.entries(parsed)) {
      normalized[key.toLowerCase()] = String(value);
    }
    return normalized;
  } catch (error) {
    die(`Could not parse --headers-json: ${error.message}`);
  }
}

function commandClassifyResponse(args) {
  const status = parseInteger(popFlag(args, '--status'), '--status', {
    min: 100,
    max: 599,
  });
  const headers = normalizeHeaders(popFlag(args, '--headers-json'));
  assertNoUnexpectedArgs(args);

  if (status === 401 || status === 403) {
    return {
      command: 'classify-response',
      status,
      classification: 'credential-or-permission-problem',
      retry: false,
      stopAfterFirstFailure: true,
      guidance:
        'Stop without retrying or calling more mittwald endpoints. Ask the operator to set or verify MITTWALD_API_TOKEN and its API roles.',
    };
  }

  if (status === 429) {
    const retryAfter =
      headers['retry-after'] || headers['x-ratelimit-reset'] || undefined;
    return {
      command: 'classify-response',
      status,
      classification: 'rate-limited',
      retry: true,
      retryAfter,
      rateLimit: {
        limit: headers['x-ratelimit-limit'],
        remaining: headers['x-ratelimit-remaining'],
        reset: headers['x-ratelimit-reset'],
      },
      guidance: retryAfter
        ? `Wait for the advertised retry window (${retryAfter}) before the next mittwald API request.`
        : 'Wait before retrying; mittwald did not provide Retry-After or X-RateLimit-Reset headers.',
    };
  }

  return {
    command: 'classify-response',
    status,
    classification: status >= 400 ? 'http-error' : 'ok',
    retry: false,
    guidance:
      status >= 400
        ? 'Report the mittwald HTTP status and response body; do not expose secrets.'
        : 'Continue with the next planned read request when needed.',
  };
}

function showHelp() {
  process.stdout.write(`mittwald skill helper

Usage:
  node skills/mittwald/mittwald.cjs [--format json] http-request <operation> [flags]
  node skills/mittwald/mittwald.cjs [--format json] plan deploy-check --project-id <project-id>
  node skills/mittwald/mittwald.cjs [--format json] event-follow-up <operation> --event-id <etag> [target flags]
  node skills/mittwald/mittwald.cjs [--format json] classify-response --status <code> [--headers-json '{}']

Core reads:
  whoami
  projects [--limit 50] [--search-term text] [--customer-id id] [--server-id id]
  project --project-id id
  apps --project-id id [--limit 50] [--search-term text]
  app --app-installation-id id
  app-status --app-installation-id id
  app-system-software --app-installation-id id [--tag-filter php]

Project resource reads:
  databases --project-id id
  mysql-databases --project-id id
  redis-databases --project-id id
  domains --project-id id [--limit 50] [--domain-search-name example.com]
  dns-zones --project-id id
  ingresses --project-id id
  backups --project-id id [--limit 50]
  cronjobs --project-id id [--limit 50] [--include-service-cronjobs]
  ssh-users --project-id id [--limit 50]
  sftp-users --project-id id [--limit 50]
  mail-addresses --project-id id [--limit 50] [--search text]
  stacks|services|volumes --project-id id [--limit 50]
  registries --project-id id
  extension-orders --project-id id
  extension-instances [--extension-id id] [--context project] [--context-id id] [--limit 50]
  licenses --project-id id
  delivery-boxes --project-id id [--limit 50]

Filesystem and diagnostics:
  directory --project-id id --directory /html [--max-depth 1]
  file-info --project-id id --file /html/index.php
  disk-usage --project-id id [--directory /html]
  service-logs --stack-id id --service-id id [--tail 200]

Guarded write operations require --operator-grant after exact F8/F14 approval:
  create-redis-database --project-id id --description name --version 7.0
  create-mysql-database --project-id id --description name --version 8.4 --password-secret MYSQL_PASSWORD
  create-app-installation --project-id id --body-json '{...}'
  create-cronjob --project-id id --body-json '{...}'
  app-action --app-installation-id id --action start|stop|restart
  service-action --stack-id id --service-id id --action start|stop|restart
  update-domain-nameservers --domain-id id --nameserver ns1.example.com --nameserver ns2.example.com
  order-extension --extension-id id --body-json '{...}'
  restore-backup-path --backup-id id --source-path /html --target-path /html-restore
`);
}

function main() {
  const args = process.argv.slice(2);
  const format = popFlag(args, '--format', 'text');
  if (popBooleanFlag(args, '--help') !== undefined || args.length === 0) {
    showHelp();
    return;
  }
  if (format !== 'json' && format !== 'text') {
    die('--format must be json or text.');
  }
  const command = args.shift();
  let result;
  if (command === 'http-request') {
    result = commandHttpRequest(args);
  } else if (command === 'plan') {
    result = commandPlan(args);
  } else if (command === 'event-follow-up') {
    result = commandEventFollowUp(args);
  } else if (command === 'classify-response') {
    result = commandClassifyResponse(args);
  } else {
    die(
      'Expected command: http-request, plan, event-follow-up, classify-response, or --help.',
    );
  }

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  API_BASE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SECRET_NAME,
  commandClassifyResponse,
  commandEventFollowUp,
  commandHttpRequest,
  commandPlan,
};
