'use strict';

const { validatePropertyOptionFromFile } = require('./hubspot-validation.cjs');

const API_BASE = 'https://api.hubapi.com';
const DEFAULT_ACCESS_TOKEN_SECRET = 'HUBSPOT_ACCESS_TOKEN';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const DEFAULT_PROPERTIES = {
  contacts: [
    'firstname',
    'lastname',
    'email',
    'phone',
    'lifecyclestage',
    'company',
  ],
  companies: ['name', 'domain', 'industry', 'lifecyclestage'],
  deals: [
    'dealname',
    'dealstage',
    'pipeline',
    'amount',
    'closedate',
    'hubspot_owner_id',
  ],
};

const SEARCH_PROPERTIES = {
  contacts: ['email', 'firstname', 'lastname', 'company'],
  companies: ['name', 'domain'],
  deals: ['dealname'],
};

const ACTIVITY_ASSOCIATION_TYPE_IDS = {
  notes: {
    contacts: 202,
    companies: 190,
    deals: 214,
  },
  tasks: {
    contacts: 204,
    companies: 192,
    deals: 216,
  },
};

const WRITE_GRANTS = {
  'update-deal-stage': 'approve-hubspot-deal-stage-update',
  'update-lifecycle-stage': 'approve-hubspot-lifecycle-stage-update',
  'create-note': 'approve-hubspot-note-create',
  'create-task': 'approve-hubspot-task-create',
};

const LIVE_EXECUTION = {
  mode: 'live-hubspot-api',
  requiresConfiguredSecrets: [DEFAULT_ACCESS_TOKEN_SECRET],
  dryRunSafe:
    'For prompt/user testing, stop after plan, workflow, or http-request payload generation; do not call http_request.',
  callPolicy:
    'For real user requests that need live HubSpot data, pass the emitted httpRequest object unchanged to http_request and let the gateway inject the token server-side.',
  secretRefPolicy:
    'Do not preflight, inspect, print, or ask the model for HUBSPOT_ACCESS_TOKEN. The bearerSecretName field is the credential reference.',
  requestShape:
    'Do not handcraft HubSpot API calls. The helper owns endpoint selection, method, payload, tier, and bearerSecretName.',
  unauthorizedPolicy:
    'If a live call returns 401 or 403, stop after the first failure. Do not retry or call additional HubSpot endpoints; ask the operator to set or verify HUBSPOT_ACCESS_TOKEN. For private apps, rotate or reveal-copy the current private app access token in HubSpot and store that exact value.',
};

function usageTotalsMeasurement() {
  return {
    system: 'UsageTotals',
    source: 'HybridClaw usage_events',
    scope: 'per assistant run/session',
    fields: [
      'total_input_tokens',
      'total_output_tokens',
      'total_tokens',
      'total_cost_usd',
      'cost_per_call_usd',
      'call_count',
      'total_tool_calls',
    ],
  };
}

function parseFlags(args, spec = {}) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawName, inlineValue] = arg.split(/=(.*)/s, 2);
    const name = rawName.slice(2);
    if (!spec[name]) {
      throw new Error(`Unknown flag: --${name}`);
    }
    if (spec[name] === 'boolean') {
      flags[name] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }
    const value = inlineValue === undefined ? args[index + 1] : inlineValue;
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}.`);
    }
    index += inlineValue === undefined ? 1 : 0;
    if (spec[name] === 'array') {
      flags[name] ??= [];
      flags[name].push(value);
    } else {
      flags[name] = value;
    }
  }
  return { flags, positional };
}

function normalizeObject(raw) {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase();
  const aliases = {
    contact: 'contacts',
    contacts: 'contacts',
    company: 'companies',
    companies: 'companies',
    deal: 'deals',
    deals: 'deals',
  };
  const object = aliases[normalized];
  if (!object) {
    throw new Error('Object must be one of contacts, companies, or deals.');
  }
  return object;
}

function assertRecordId(id, label = 'record id') {
  const value = String(id || '').trim();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw new Error(`Invalid HubSpot ${label}.`);
  }
  return value;
}

function parseProperties(flags, object) {
  const fromFlag = flags.property || flags.properties;
  const values = Array.isArray(fromFlag)
    ? fromFlag
    : typeof fromFlag === 'string'
      ? fromFlag.split(',')
      : DEFAULT_PROPERTIES[object];
  const properties = values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(properties)];
}

function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return value;
}

function requireGrant(flags, operation) {
  const requiredGrant = WRITE_GRANTS[operation];
  const grant = String(flags.grant || '').trim();
  if (flags['operator-grant'] === true || grant === requiredGrant) {
    return requiredGrant;
  }
  throw new Error(
    `${operation} requires explicit grant \`${requiredGrant}\` or --operator-grant.`,
  );
}

function buildUrl(pathname, query = {}) {
  const url = new URL(pathname, API_BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) url.searchParams.set(key, value.join(','));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function buildHttpRequest({ url, method = 'GET', json, maxResponseBytes }) {
  return {
    url,
    method,
    ...(json ? { json } : {}),
    bearerSecretName: DEFAULT_ACCESS_TOKEN_SECRET,
    skillName: 'hubspot',
    ...(maxResponseBytes ? { maxResponseBytes } : {}),
  };
}

function wrap(command, httpRequest, extra = {}) {
  return {
    command,
    httpRequest,
    costMeasurement: usageTotalsMeasurement(),
    liveExecution: LIVE_EXECUTION,
    ...extra,
  };
}

function buildListRequest(args, options = {}) {
  const { flags, positional } = parseFlags(args, {
    property: 'array',
    properties: 'string',
    limit: 'string',
    after: 'string',
  });
  const object = normalizeObject(positional[0]);
  const limit = parseLimit(flags.limit);
  const properties = parseProperties(flags, object);
  const httpRequest = buildHttpRequest({
    url: buildUrl(`/crm/v3/objects/${object}`, {
      limit,
      after: flags.after,
      properties,
      archived: false,
    }),
    maxResponseBytes: options.maxResponseBytes,
  });
  return wrap('list', httpRequest, { object, properties, limit });
}

function buildSearchRequest(args, options = {}) {
  const { flags, positional } = parseFlags(args, {
    query: 'string',
    property: 'array',
    properties: 'string',
    limit: 'string',
    after: 'string',
  });
  const object = normalizeObject(positional[0]);
  const query = String(flags.query || positional.slice(1).join(' ')).trim();
  if (!query) throw new Error('search requires --query or a query argument.');
  const limit = parseLimit(flags.limit);
  const searchProperties = SEARCH_PROPERTIES[object];
  const filters = searchProperties.map((propertyName) => ({
    propertyName,
    operator: 'CONTAINS_TOKEN',
    value: query,
  }));
  const httpRequest = buildHttpRequest({
    url: buildUrl(`/crm/v3/objects/${object}/search`),
    method: 'POST',
    json: {
      filterGroups: filters.map((filter) => ({ filters: [filter] })),
      properties: parseProperties(flags, object),
      limit,
      ...(flags.after ? { after: flags.after } : {}),
    },
    maxResponseBytes: options.maxResponseBytes,
  });
  return wrap('search', httpRequest, { object, query, limit });
}

function buildGetRequest(args, options = {}) {
  const { flags, positional } = parseFlags(args, {
    property: 'array',
    properties: 'string',
    associations: 'string',
  });
  const object = normalizeObject(positional[0]);
  const id = assertRecordId(positional[1]);
  const httpRequest = buildHttpRequest({
    url: buildUrl(`/crm/v3/objects/${object}/${id}`, {
      properties: parseProperties(flags, object),
      associations: flags.associations,
      archived: false,
    }),
    maxResponseBytes: options.maxResponseBytes,
  });
  return wrap('get', httpRequest, { object, id });
}

function buildPropertiesRequest(args, options = {}) {
  const { flags, positional } = parseFlags(args, {
    archived: 'boolean',
  });
  const object = normalizeObject(positional[0]);
  return wrap(
    'properties',
    buildHttpRequest({
      url: buildUrl(`/crm/v3/properties/${object}`, {
        archived: flags.archived === true,
      }),
      maxResponseBytes: options.maxResponseBytes,
    }),
    { object },
  );
}

function buildUpdateDealStageRequest(args) {
  const { flags, positional } = parseFlags(args, {
    stage: 'string',
    pipeline: 'string',
    'properties-file': 'string',
    grant: 'string',
    'operator-grant': 'boolean',
  });
  const id = assertRecordId(positional[0], 'deal id');
  let stage = String(flags.stage || positional.slice(1).join(' ')).trim();
  if (!stage) throw new Error('update-deal-stage requires --stage.');
  if (flags['properties-file']) {
    const validated = validatePropertyOptionFromFile({
      filePath: flags['properties-file'],
      propertyName: 'dealstage',
      value: stage,
    });
    stage = validated.value;
  }
  const requiredGrant = requireGrant(flags, 'update-deal-stage');
  return wrap(
    'update-deal-stage',
    buildHttpRequest({
      url: buildUrl(`/crm/v3/objects/deals/${id}`),
      method: 'PATCH',
      json: {
        properties: {
          dealstage: stage,
          ...(flags.pipeline ? { pipeline: flags.pipeline } : {}),
        },
      },
    }),
    { id, stage, requiredGrant },
  );
}

function buildUpdateLifecycleStageRequest(args) {
  const { flags, positional } = parseFlags(args, {
    stage: 'string',
    'properties-file': 'string',
    grant: 'string',
    'operator-grant': 'boolean',
  });
  const object = normalizeObject(positional[0]);
  const id = assertRecordId(positional[1]);
  let stage = String(flags.stage || positional.slice(2).join(' ')).trim();
  if (!stage) throw new Error('update-lifecycle-stage requires --stage.');
  if (flags['properties-file']) {
    const validated = validatePropertyOptionFromFile({
      filePath: flags['properties-file'],
      propertyName: 'lifecyclestage',
      value: stage,
    });
    stage = validated.value;
  }
  const requiredGrant = requireGrant(flags, 'update-lifecycle-stage');
  return wrap(
    'update-lifecycle-stage',
    buildHttpRequest({
      url: buildUrl(`/crm/v3/objects/${object}/${id}`),
      method: 'PATCH',
      json: { properties: { lifecyclestage: stage } },
    }),
    { object, id, stage, requiredGrant },
  );
}

function buildAssociation(
  activityObject,
  associatedObject,
  associatedId,
  overrideTypeId,
) {
  if (!associatedObject && !associatedId) return undefined;
  if (!associatedObject || !associatedId) {
    throw new Error(
      '--associate-object and --associate-id must be provided together.',
    );
  }
  const object = normalizeObject(associatedObject);
  const associationTypeId =
    overrideTypeId === undefined
      ? ACTIVITY_ASSOCIATION_TYPE_IDS[activityObject][object]
      : Number.parseInt(String(overrideTypeId), 10);
  if (!Number.isInteger(associationTypeId) || associationTypeId <= 0) {
    throw new Error('--association-type-id must be a positive integer.');
  }
  return [
    {
      to: { id: assertRecordId(associatedId) },
      types: [
        {
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId,
        },
      ],
    },
  ];
}

function normalizeTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'now') return new Date().toISOString();
  if (raw.toLowerCase() === 'today')
    return new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(
      'Timestamp must be ISO 8601, YYYY-MM-DD, milliseconds, today, or now.',
    );
  }
  return new Date(parsed).toISOString();
}

function buildCreateNoteRequest(args) {
  const { flags } = parseFlags(args, {
    body: 'string',
    timestamp: 'string',
    owner: 'string',
    'attachment-ids': 'string',
    'associate-object': 'string',
    'associate-id': 'string',
    'association-type-id': 'string',
    grant: 'string',
    'operator-grant': 'boolean',
  });
  const body = String(flags.body || '').trim();
  if (!body) throw new Error('create-note requires --body.');
  const requiredGrant = requireGrant(flags, 'create-note');
  const associations = buildAssociation(
    'notes',
    flags['associate-object'],
    flags['associate-id'],
    flags['association-type-id'],
  );
  return wrap(
    'create-note',
    buildHttpRequest({
      url: buildUrl('/crm/v3/objects/notes'),
      method: 'POST',
      json: {
        properties: {
          hs_timestamp: normalizeTimestamp(flags.timestamp || 'now'),
          hs_note_body: body,
          ...(flags.owner ? { hubspot_owner_id: flags.owner } : {}),
          ...(flags['attachment-ids']
            ? { hs_attachment_ids: flags['attachment-ids'] }
            : {}),
        },
        ...(associations ? { associations } : {}),
      },
    }),
    { requiredGrant },
  );
}

function buildCreateTaskRequest(args) {
  const { flags } = parseFlags(args, {
    subject: 'string',
    body: 'string',
    due: 'string',
    status: 'string',
    priority: 'string',
    owner: 'string',
    'associate-object': 'string',
    'associate-id': 'string',
    'association-type-id': 'string',
    grant: 'string',
    'operator-grant': 'boolean',
  });
  const subject = String(flags.subject || '').trim();
  if (!subject) throw new Error('create-task requires --subject.');
  const requiredGrant = requireGrant(flags, 'create-task');
  const associations = buildAssociation(
    'tasks',
    flags['associate-object'],
    flags['associate-id'],
    flags['association-type-id'],
  );
  return wrap(
    'create-task',
    buildHttpRequest({
      url: buildUrl('/crm/v3/objects/tasks'),
      method: 'POST',
      json: {
        properties: {
          hs_timestamp: normalizeTimestamp(flags.due || 'today'),
          hs_task_subject: subject,
          hs_task_status: String(flags.status || 'NOT_STARTED').toUpperCase(),
          ...(flags.body ? { hs_task_body: flags.body } : {}),
          ...(flags.priority
            ? { hs_task_priority: String(flags.priority).toUpperCase() }
            : {}),
          ...(flags.owner ? { hubspot_owner_id: flags.owner } : {}),
        },
        ...(associations ? { associations } : {}),
      },
    }),
    { requiredGrant },
  );
}

function buildHttpRequestCommand(args, options = {}) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'list') return buildListRequest(rest, options);
  if (sub === 'search') return buildSearchRequest(rest, options);
  if (sub === 'get') return buildGetRequest(rest, options);
  if (sub === 'properties') return buildPropertiesRequest(rest, options);
  if (sub === 'update-deal-stage') return buildUpdateDealStageRequest(rest);
  if (sub === 'update-lifecycle-stage')
    return buildUpdateLifecycleStageRequest(rest);
  if (sub === 'create-note') return buildCreateNoteRequest(rest);
  if (sub === 'create-task') return buildCreateTaskRequest(rest);
  throw new Error(`Unknown http-request command: ${sub || '(missing)'}`);
}

module.exports = {
  ACTIVITY_ASSOCIATION_TYPE_IDS,
  WRITE_GRANTS,
  buildHttpRequestCommand,
  buildPropertiesRequest,
  buildCreateNoteRequest,
  buildCreateTaskRequest,
  buildSearchRequest,
  buildUpdateDealStageRequest,
  buildUpdateLifecycleStageRequest,
  normalizeObject,
  parseFlags,
  usageTotalsMeasurement,
};
