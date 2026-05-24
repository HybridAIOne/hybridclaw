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
  callPolicy:
    'Pass the emitted httpRequest object unchanged to http_request so the gateway injects the bearer token server-side.',
  secretRefPolicy:
    'Do not preflight, inspect, print, or ask the model for MITTWALD_API_TOKEN. bearerSecretName is the credential reference.',
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
  'check-domain-availability': 'green',
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
const LIFECYCLE_ACTIONS = new Set(['start', 'stop', 'restart']);

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

function projectPath(project) {
  return `${API_BASE}/projects/${encodeSegment(project, '--project-id')}`;
}

function projectResourcePath(project, resource) {
  return `${projectPath(project)}/${resource}`;
}

function appInstallationPath(app) {
  return `${API_BASE}/app-installations/${encodeSegment(app, '--app-installation-id')}`;
}

function appInstallationResourcePath(app, resource) {
  return `${appInstallationPath(app)}/${resource}`;
}

function domainPath(domain) {
  return `${API_BASE}/domains/${encodeSegment(domain, '--domain-id')}`;
}

function domainResourcePath(domain, resource) {
  return `${domainPath(domain)}/${resource}`;
}

function backupPath(backup) {
  return `${API_BASE}/project-backups/${encodeSegment(backup, '--backup-id')}`;
}

function backupResourcePath(backup, resource) {
  return `${backupPath(backup)}/${resource}`;
}

function servicePath(stack, service) {
  return `${API_BASE}/stacks/${encodeSegment(stack, '--stack-id')}/services/${encodeSegment(service, '--service-id')}`;
}

function serviceResourcePath(stack, service, resource) {
  return `${servicePath(stack, service)}/${resource}`;
}

function followUpArgv(operation, targetArgs) {
  return [
    'node',
    'skills/mittwald/mittwald.cjs',
    '--format',
    'json',
    'event-follow-up',
    operation,
    ...targetArgs,
    '--event-id',
    '<etag>',
  ];
}

function planStep(operation, ...flags) {
  return {
    operation,
    argv: [
      'node',
      'skills/mittwald/mittwald.cjs',
      '--format',
      'json',
      'http-request',
      operation,
      ...flags,
    ],
  };
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

function requireObjectFields(object, operation, fields) {
  for (const field of fields) {
    if (
      object[field] === undefined ||
      object[field] === null ||
      object[field] === ''
    ) {
      die(`${operation} --body-json requires ${field}.`);
    }
  }
}

function validateAppInstallationBody(json) {
  requireObjectFields(json, 'create-app-installation', [
    'appVersionId',
    'description',
    'updatePolicy',
    'userInputs',
  ]);
  if (!Array.isArray(json.userInputs)) {
    die('create-app-installation --body-json userInputs must be an array.');
  }
  return json;
}

function validateCronjobBody(json) {
  requireObjectFields(json, 'create-cronjob', [
    'description',
    'interval',
    'target',
  ]);
  if (typeof json.target !== 'object' || Array.isArray(json.target)) {
    die('create-cronjob --body-json target must be an object.');
  }
  return json;
}

function validateBackupRestoreBody(json) {
  if (json.pathRestore === undefined && json.databaseRestores === undefined) {
    die('restore-backup --body-json requires pathRestore or databaseRestores.');
  }
  if (
    json.databaseRestores !== undefined &&
    !Array.isArray(json.databaseRestores)
  ) {
    die('restore-backup --body-json databaseRestores must be an array.');
  }
  if (
    json.pathRestore !== undefined &&
    (typeof json.pathRestore !== 'object' || Array.isArray(json.pathRestore))
  ) {
    die('restore-backup --body-json pathRestore must be an object.');
  }
  return json;
}

function validateExtensionOrderBody(json) {
  requireObjectFields(json, 'order-extension', ['consentedScopes']);
  if (!Array.isArray(json.consentedScopes)) {
    die('order-extension --body-json consentedScopes must be an array.');
  }
  if (!json.projectId && !json.customerId) {
    die('order-extension --body-json requires projectId or customerId.');
  }
  if (json.projectId && json.customerId) {
    die(
      'order-extension --body-json accepts projectId or customerId, not both.',
    );
  }
  return json;
}

function validateIsoDateTime(value, label) {
  const date = requireText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(date)) {
    die(
      `${label} must be an ISO 8601 UTC timestamp such as 2026-06-01T00:00:00Z.`,
    );
  }
  return date;
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
  return requireText(popFlag(args, '--project-id'), '--project-id');
}

function appId(args) {
  const value = popFlag(args, '--app-installation-id');
  if (value !== undefined) {
    return requireText(value, '--app-installation-id');
  }
  return requireText(
    popFlag(args, '--app-id'),
    '--app-installation-id (or --app-id)',
  );
}

function backupId(args) {
  return requireText(popFlag(args, '--backup-id'), '--backup-id');
}

function domainId(args) {
  return requireText(popFlag(args, '--domain-id'), '--domain-id');
}

function stackAndService(args) {
  return {
    stack: requireText(popFlag(args, '--stack-id'), '--stack-id'),
    service: requireText(popFlag(args, '--service-id'), '--service-id'),
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

function projectListRequest(operation, args, resource, allowed = {}) {
  const project = projectId(args);
  const query = listQuery(args, allowed);
  return wrapHttpRequest(operation, {
    url: appendQuery(projectResourcePath(project, resource), query),
  });
}

const OPERATION_HANDLERS = {
  whoami: (operation) =>
    wrapHttpRequest(operation, { url: `${API_BASE}/user` }),
  projects: (operation, args) =>
    wrapHttpRequest(operation, {
      url: appendQuery(
        `${API_BASE}/projects`,
        listQuery(args, {
          '--customer-id': 'customerId',
          '--server-id': 'serverId',
          '--search-term': 'searchTerm',
          '--sort': 'sort',
          '--order': 'order',
        }),
      ),
    }),
  project: (operation, args) =>
    wrapHttpRequest(operation, { url: projectPath(projectId(args)) }),
  apps: (operation, args) =>
    projectListRequest(operation, args, 'app-installations', {
      '--search-term': 'searchTerm',
      '--sort-order': 'sortOrder',
    }),
  app: (operation, args) =>
    wrapHttpRequest(operation, { url: appInstallationPath(appId(args)) }),
  'app-status': (operation, args) =>
    wrapHttpRequest(operation, {
      url: appInstallationResourcePath(appId(args), 'status'),
    }),
  'app-system-software': (operation, args) => {
    const app = appId(args);
    const tagFilter = popFlag(args, '--tag-filter');
    return wrapHttpRequest(operation, {
      url: appendQuery(appInstallationResourcePath(app, 'systemSoftware'), {
        tagFilter,
      }),
    });
  },
  databases: (operation, args) => {
    const project = projectId(args);
    const mysql = wrapHttpRequest('mysql-databases', {
      url: projectResourcePath(project, 'mysql-databases'),
    });
    const redis = wrapHttpRequest('redis-databases', {
      url: projectResourcePath(project, 'redis-databases'),
    });
    return wrapHttpRequests(operation, [mysql, redis], {
      note: 'Pass each httpRequests item to http_request, then merge MySQL and Redis results in the answer.',
    });
  },
  'mysql-databases': (operation, args) =>
    wrapHttpRequest(operation, {
      url: projectResourcePath(projectId(args), 'mysql-databases'),
    }),
  'redis-databases': (operation, args) =>
    wrapHttpRequest(operation, {
      url: projectResourcePath(projectId(args), 'redis-databases'),
    }),
  domains: (operation, args) =>
    projectListRequest(operation, args, 'domains', {
      '--domain-search-name': 'domainSearchName',
    }),
  'dns-zones': (operation, args) =>
    wrapHttpRequest(operation, {
      url: projectResourcePath(projectId(args), 'dns-zones'),
    }),
  ingresses: (operation, args) =>
    wrapHttpRequest(operation, {
      url: projectResourcePath(projectId(args), 'ingresses'),
    }),
  backups: (operation, args) => {
    const project = projectId(args);
    const query = listQuery(args, {
      '--search-term': 'searchTerm',
      '--sort-order': 'sortOrder',
    });
    const withExportsOnly = popBooleanFlag(args, '--with-exports-only');
    const runningRestoresOnly = popBooleanFlag(args, '--running-restores-only');
    const runningBackupsOnly = popBooleanFlag(args, '--running-backups-only');
    return wrapHttpRequest(operation, {
      url: appendQuery(projectResourcePath(project, 'backups'), {
        ...query,
        withExportsOnly,
        runningRestoresOnly,
        runningBackupsOnly,
      }),
    });
  },
  'backup-path': (operation, args) => {
    const backup = backupId(args);
    const path = popFlag(args, '--path');
    return wrapHttpRequest(operation, {
      url: appendQuery(backupResourcePath(backup, 'path'), { path }),
    });
  },
  'backup-database-dumps': (operation, args) =>
    wrapHttpRequest(operation, {
      url: backupResourcePath(backupId(args), 'database-dumps'),
    }),
  cronjobs: (operation, args) => {
    const project = projectId(args);
    const query = listQuery(args);
    const includeServiceCronjobs = popBooleanFlag(
      args,
      '--include-service-cronjobs',
    );
    return wrapHttpRequest(operation, {
      url: appendQuery(projectResourcePath(project, 'cronjobs'), {
        ...query,
        includeServiceCronjobs,
      }),
    });
  },
  'ssh-users': (operation, args) =>
    projectListRequest(operation, args, operation),
  'sftp-users': (operation, args) =>
    projectListRequest(operation, args, operation),
  'mail-addresses': (operation, args) =>
    projectListRequest(operation, args, 'mail-addresses', {
      '--search': 'search',
    }),
  'delivery-boxes': (operation, args) =>
    projectListRequest(operation, args, 'delivery-boxes'),
  'mail-settings': (operation, args) =>
    wrapHttpRequest(operation, {
      url: projectResourcePath(projectId(args), 'mail-settings'),
    }),
  stacks: (operation, args) =>
    projectListRequest(operation, args, operation, {
      '--search-term': 'searchTerm',
      '--sort-order': 'sortOrder',
      '--stack-id': 'stackId',
      '--status': 'status',
    }),
  services: (operation, args) =>
    projectListRequest(operation, args, operation, {
      '--search-term': 'searchTerm',
      '--sort-order': 'sortOrder',
      '--stack-id': 'stackId',
      '--status': 'status',
    }),
  volumes: (operation, args) =>
    projectListRequest(operation, args, operation, {
      '--search-term': 'searchTerm',
      '--sort-order': 'sortOrder',
      '--stack-id': 'stackId',
      '--status': 'status',
    }),
  registries: (operation, args) =>
    wrapHttpRequest(operation, {
      url: projectResourcePath(projectId(args), 'registries'),
    }),
  'service-logs': (operation, args) => {
    const { stack, service } = stackAndService(args);
    const tail = popFlag(args, '--tail', '200');
    return wrapHttpRequest(operation, {
      url: appendQuery(serviceResourcePath(stack, service, 'logs'), {
        tail: parseInteger(tail, '--tail', { min: 1, max: 2_000 }),
      }),
    });
  },
  'file-info': (operation, args) => {
    const project = projectId(args);
    const file = requireText(popFlag(args, '--file'), '--file');
    return wrapHttpRequest(operation, {
      url: appendQuery(projectResourcePath(project, 'filesystem/files'), {
        file,
      }),
    });
  },
  directory: (operation, args) => {
    const project = projectId(args);
    const directory = requireText(popFlag(args, '--directory'), '--directory');
    const maxDepth = popFlag(args, '--max-depth', '1');
    return wrapHttpRequest(operation, {
      url: appendQuery(projectResourcePath(project, 'filesystem/directories'), {
        directory,
        max_depth: parseInteger(maxDepth, '--max-depth', {
          min: 0,
          max: 5,
        }),
        name: popFlag(args, '--name'),
      }),
    });
  },
  'disk-usage': (operation, args) => {
    const project = projectId(args);
    const directory = popFlag(args, '--directory');
    return wrapHttpRequest(operation, {
      url: appendQuery(projectResourcePath(project, 'filesystem/usages/disk'), {
        directory,
      }),
    });
  },
  'extension-orders': (operation, args) =>
    wrapHttpRequest(operation, {
      url: projectResourcePath(projectId(args), 'extension-orders'),
    }),
  'extension-instances': (operation, args) =>
    wrapHttpRequest(operation, {
      url: appendQuery(
        `${API_BASE}/extension-instances`,
        listQuery(args, {
          '--context': 'context',
          '--context-id': 'contextId',
          '--extension-id': 'extensionId',
          '--search-term': 'searchTerm',
        }),
      ),
    }),
  'extension-instance': (operation, args) =>
    wrapHttpRequest(operation, {
      url: `${API_BASE}/extension-instances/${encodeSegment(
        popFlag(args, '--extension-instance-id'),
        '--extension-instance-id',
      )}`,
    }),
  licenses: (operation, args) =>
    wrapHttpRequest(operation, {
      url: projectResourcePath(projectId(args), 'licenses'),
    }),
  domain: (operation, args) =>
    wrapHttpRequest(operation, { url: domainPath(domainId(args)) }),
  backup: (operation, args) =>
    wrapHttpRequest(operation, { url: backupPath(backupId(args)) }),
  service: (operation, args) => {
    const { stack, service } = stackAndService(args);
    return wrapHttpRequest(operation, { url: servicePath(stack, service) });
  },
  'create-redis-database': (operation, args) => {
    const project = projectId(args);
    const description = requireText(
      popFlag(args, '--description'),
      '--description',
    );
    const version = requireText(popFlag(args, '--version'), '--version');
    const target = `project:${project} redis:${description}`;
    return wrapMutation(
      operation,
      {
        url: projectResourcePath(project, 'redis-databases'),
        method: 'POST',
        json: { description, version },
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--project-id', project]),
        verifies: 'redis database appears in project database inventory',
      },
    );
  },
  'create-mysql-database': (operation, args) => {
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
    return wrapMutation(
      operation,
      {
        url: projectResourcePath(project, 'mysql-databases'),
        method: 'POST',
        json: {
          database: { description, version },
          user,
        },
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--project-id', project]),
        verifies: 'MySQL database appears in project database inventory',
      },
    );
  },
  'create-app-installation': (operation, args) => {
    const project = projectId(args);
    const json = validateAppInstallationBody(
      parseJsonFlag(args, '--body-json'),
    );
    const target = `project:${project} appVersion:${json.appVersionId || 'unknown'}`;
    return wrapMutation(
      operation,
      {
        url: projectResourcePath(project, 'app-installations'),
        method: 'POST',
        json,
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--project-id', project]),
        verifies: 'app installation appears in project app list',
      },
    );
  },
  'create-cronjob': (operation, args) => {
    const project = projectId(args);
    const json = validateCronjobBody(parseJsonFlag(args, '--body-json'));
    const target = `project:${project} cronjob:${json.description || json.interval || 'new'}`;
    return wrapMutation(
      operation,
      {
        url: projectResourcePath(project, 'cronjobs'),
        method: 'POST',
        json,
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--project-id', project]),
        verifies: 'cronjob appears in project cronjob list',
      },
    );
  },
  'app-action': (operation, args) => {
    const app = appId(args);
    const action = assertAllowedAction(
      popFlag(args, '--action'),
      LIFECYCLE_ACTIONS,
      '--action',
    );
    const target = `app-installation:${app} action:${action}`;
    return wrapMutation(
      operation,
      {
        url: appInstallationResourcePath(app, `actions/${action}`),
        method: 'POST',
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--app-installation-id', app]),
        verifies: 'app runtime status reflects requested action',
      },
    );
  },
  'service-action': (operation, args) => {
    const { stack, service } = stackAndService(args);
    const action = assertAllowedAction(
      popFlag(args, '--action'),
      LIFECYCLE_ACTIONS,
      '--action',
    );
    const target = `stack:${stack} service:${service} action:${action}`;
    return wrapMutation(
      operation,
      {
        url: serviceResourcePath(stack, service, `actions/${action}`),
        method: 'POST',
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, [
          '--stack-id',
          stack,
          '--service-id',
          service,
        ]),
        verifies: 'service status reflects requested action',
      },
    );
  },
  'change-domain-project': (operation, args) => {
    const domain = domainId(args);
    const nextProject = requireText(
      popFlag(args, '--target-project-id'),
      '--target-project-id',
    );
    const target = `domain:${domain} target-project:${nextProject}`;
    return wrapMutation(
      operation,
      {
        url: domainResourcePath(domain, 'project-id'),
        method: 'PATCH',
        json: { projectId: nextProject },
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--domain-id', domain]),
        verifies: 'domain project id matches target project',
      },
    );
  },
  'update-domain-nameservers': (operation, args) => {
    const domain = domainId(args);
    const nameservers = popRepeatedFlag(args, '--nameserver');
    if (nameservers.length < 2) {
      die(
        'update-domain-nameservers requires at least two --nameserver values.',
      );
    }
    const target = `domain:${domain} nameservers:${nameservers.join(',')}`;
    return wrapMutation(
      operation,
      {
        url: domainResourcePath(domain, 'nameservers'),
        method: 'PATCH',
        json: { nameservers },
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--domain-id', domain]),
        verifies: 'domain nameservers match requested set',
      },
    );
  },
  'schedule-domain-deletion': (operation, args) => {
    const domain = domainId(args);
    const deletionDate = validateIsoDateTime(
      popFlag(args, '--deletion-date'),
      '--deletion-date',
    );
    const deleteIngresses = popBooleanFlag(args, '--delete-ingresses') === true;
    const target = `domain:${domain} deletion-date:${deletionDate}`;
    return wrapMutation(
      operation,
      {
        url: domainResourcePath(domain, 'scheduled-deletion'),
        method: 'POST',
        json: { deletionDate, deleteIngresses },
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--domain-id', domain]),
        verifies: 'domain scheduled deletion is visible',
      },
    );
  },
  'cancel-domain-deletion': (operation, args) => {
    const domain = domainId(args);
    const target = `domain:${domain} scheduled-deletion`;
    return wrapMutation(
      operation,
      {
        url: domainResourcePath(domain, 'scheduled-deletion'),
        method: 'DELETE',
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--domain-id', domain]),
        verifies: 'domain scheduled deletion is absent',
      },
    );
  },
  'check-domain-availability': (operation, args) => {
    const domain = requireText(popFlag(args, '--domain'), '--domain');
    return wrapHttpRequest(operation, {
      url: `${API_BASE}/domains`,
      method: 'POST',
      json: { domain },
    });
  },
  'restore-backup': (operation, args) => {
    const backup = backupId(args);
    const json = validateBackupRestoreBody(parseJsonFlag(args, '--body-json'));
    const target = `project-backup:${backup}`;
    return wrapMutation(
      operation,
      {
        url: backupResourcePath(backup, 'restore'),
        method: 'POST',
        json,
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--backup-id', backup]),
        verifies: 'backup restore status is visible on the backup',
      },
    );
  },
  'restore-backup-path': (operation, args) => {
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
    return wrapMutation(
      operation,
      {
        url: backupResourcePath(backup, 'restore-path'),
        method: 'POST',
        json,
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--backup-id', backup]),
        verifies: 'backup path restore status is visible on the backup',
      },
    );
  },
  'validate-license-key': (operation, args) => {
    const project = projectId(args);
    const key = secretPlaceholder(args, '--license-key-secret');
    const kind = requireText(popFlag(args, '--kind'), '--kind');
    const target = `project:${project} license-kind:${kind}`;
    return wrapMutation(
      operation,
      {
        url: projectResourcePath(project, 'actions/validate-license-key'),
        method: 'POST',
        json: { key, kind },
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--project-id', project]),
        verifies: 'project licenses reflect validation result when applicable',
      },
    );
  },
  'order-extension': (operation, args) => {
    const extension = requireText(
      popFlag(args, '--extension-id'),
      '--extension-id',
    );
    const json = validateExtensionOrderBody(parseJsonFlag(args, '--body-json'));
    const target = `extension:${extension} context:${json.projectId || json.customerId || 'unknown'}`;
    return wrapMutation(
      operation,
      {
        url: `${API_BASE}/extensions/${encodeSegment(extension, '--extension-id')}/order`,
        method: 'POST',
        json,
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--extension-id', extension]),
        verifies:
          'extension instance or extension order reflects the marketplace order',
      },
    );
  },
  'create-delivery-box': (operation, args) => {
    const project = projectId(args);
    const description = requireText(
      popFlag(args, '--description'),
      '--description',
    );
    const password = secretPlaceholder(args, '--password-secret');
    const target = `project:${project} delivery-box:${description}`;
    return wrapMutation(
      operation,
      {
        url: projectResourcePath(project, 'delivery-boxes'),
        method: 'POST',
        json: { description, password },
      },
      requireGrant(args, operation, target),
      {
        argv: followUpArgv(operation, ['--project-id', project]),
        verifies: 'delivery box is visible in project mail resources',
      },
    );
  },
};

function commandHttpRequest(args) {
  const operation = args.shift();
  if (!operation) die('http-request requires an operation.');
  if (!HTTP_OPERATIONS.has(operation)) {
    die(`Unknown mittwald http-request operation: ${operation}`);
  }
  const handler = OPERATION_HANDLERS[operation];
  if (!handler) {
    die(`Unsupported mittwald http-request operation: ${operation}`);
  }
  const payload = handler(operation, args);
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
          url: projectResourcePath(project, 'mysql-databases'),
          headers,
        }),
        wrapHttpRequest('redis-databases', {
          url: projectResourcePath(project, 'redis-databases'),
          headers,
        }),
      ]);
      break;
    }
    case 'create-app-installation':
      payload = wrapHttpRequest('apps', {
        url: appendQuery(
          projectResourcePath(projectId(args), 'app-installations'),
          {
            limit: DEFAULT_LIMIT,
          },
        ),
        headers,
      });
      break;
    case 'create-cronjob':
      payload = wrapHttpRequest('cronjobs', {
        url: appendQuery(projectResourcePath(projectId(args), 'cronjobs'), {
          limit: DEFAULT_LIMIT,
        }),
        headers,
      });
      break;
    case 'app-action':
      payload = wrapHttpRequest('app-status', {
        url: appInstallationResourcePath(appId(args), 'status'),
        headers,
      });
      break;
    case 'service-action': {
      const { stack, service } = stackAndService(args);
      payload = wrapHttpRequest('service', {
        url: servicePath(stack, service),
        headers,
      });
      break;
    }
    case 'change-domain-project':
    case 'update-domain-nameservers':
    case 'schedule-domain-deletion':
    case 'cancel-domain-deletion':
      payload = wrapHttpRequest('domain', {
        url: domainPath(domainId(args)),
        headers,
      });
      break;
    case 'restore-backup':
    case 'restore-backup-path':
      payload = wrapHttpRequest('backup', {
        url: backupPath(backupId(args)),
        headers,
      });
      break;
    case 'validate-license-key':
      payload = wrapHttpRequest('licenses', {
        url: projectResourcePath(projectId(args), 'licenses'),
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
          projectResourcePath(projectId(args), 'delivery-boxes'),
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
      planStep('project', '--project-id', project),
      planStep(
        'apps',
        '--project-id',
        project,
        '--limit',
        String(DEFAULT_LIMIT),
      ),
      planStep('databases', '--project-id', project),
      planStep(
        'domains',
        '--project-id',
        project,
        '--limit',
        String(DEFAULT_LIMIT),
      ),
      planStep('ingresses', '--project-id', project),
      planStep(
        'cronjobs',
        '--project-id',
        project,
        '--limit',
        String(DEFAULT_LIMIT),
      ),
      planStep(
        'backups',
        '--project-id',
        project,
        '--limit',
        String(DEFAULT_LIMIT),
      ),
      planStep(
        'services',
        '--project-id',
        project,
        '--limit',
        String(DEFAULT_LIMIT),
      ),
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
  domain --domain-id id
  backup --backup-id id
  service --stack-id id --service-id id

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
  check-domain-availability --domain example.com

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
  change-domain-project --domain-id id --target-project-id id
  update-domain-nameservers --domain-id id --nameserver ns1.example.com --nameserver ns2.example.com
  schedule-domain-deletion --domain-id id --deletion-date 2026-06-01T00:00:00Z
  cancel-domain-deletion --domain-id id
  restore-backup --backup-id id --body-json '{...}'
  restore-backup-path --backup-id id --source-path /html --target-path /html-restore
  validate-license-key --project-id id --kind typo3-elts --license-key-secret MITTWALD_LICENSE_KEY
  order-extension --extension-id id --body-json '{...}'
  create-delivery-box --project-id id --description name --password-secret MITTWALD_MAIL_PASSWORD
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
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
