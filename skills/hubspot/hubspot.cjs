#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const API_BASE = 'https://api.hubapi.com';
const DEFAULT_ACCESS_TOKEN_SECRET = 'HUBSPOT_ACCESS_TOKEN';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');

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

function printHelp() {
  process.stdout.write(`HubSpot skill helper

Usage:
  node skills/hubspot/hubspot.cjs [--format json|text] <command> [options]

Commands:
  plan <request>                         Classify a natural-language CRM request
  workflow <request>                     Build ordered lookup/validation/API steps
  validate-option                        Validate a HubSpot property option from saved JSON
  explain-error                          Interpret a saved HubSpot/http_request error
  http-request list <object>             Build a list records request
  http-request search <object>           Build a CRM search request
  http-request get <object> <id>         Build a get-by-id request
  http-request properties <object>       Build a properties metadata request
  http-request update-deal-stage <id>    Build a guarded dealstage PATCH
  http-request update-lifecycle-stage <object> <id>
                                          Build a guarded lifecyclestage PATCH
  http-request create-note               Build a guarded note create request
  http-request create-task               Build a guarded task create request
  eval-scenarios                         Run the offline planner fixture suite

Objects:
  contacts, companies, deals

Write grants:
  ${WRITE_GRANTS['update-deal-stage']}
  ${WRITE_GRANTS['update-lifecycle-stage']}
  ${WRITE_GRANTS['create-note']}
  ${WRITE_GRANTS['create-task']}
`);
}

function parseGlobalArgs(argv) {
  const parsed = {
    format: 'text',
    args: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--format') {
      parsed.format = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--format=')) {
      parsed.format = arg.slice('--format='.length);
      continue;
    }
    parsed.args.push(arg);
  }
  if (!['json', 'text'].includes(parsed.format)) {
    throw new Error('--format must be "json" or "text".');
  }
  return parsed;
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

function normalizeActivityObject(raw) {
  const object = normalizeObject(raw);
  if (!['contacts', 'companies', 'deals'].includes(object)) {
    throw new Error(
      'Activity association object must be contacts, companies, or deals.',
    );
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
    ...extra,
  };
}

function buildListRequest(args) {
  const { flags, positional } = parseFlags(args, {
    property: 'array',
    properties: 'string',
    limit: 'string',
    after: 'string',
    'max-response-bytes': 'string',
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
    maxResponseBytes: flags['max-response-bytes']
      ? Number.parseInt(flags['max-response-bytes'], 10)
      : undefined,
  });
  return wrap('list', httpRequest, { object, properties, limit });
}

function buildSearchRequest(args) {
  const { flags, positional } = parseFlags(args, {
    query: 'string',
    property: 'array',
    properties: 'string',
    limit: 'string',
    after: 'string',
    'max-response-bytes': 'string',
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
    maxResponseBytes: flags['max-response-bytes']
      ? Number.parseInt(flags['max-response-bytes'], 10)
      : undefined,
  });
  return wrap('search', httpRequest, { object, query, limit });
}

function buildGetRequest(args) {
  const { flags, positional } = parseFlags(args, {
    property: 'array',
    properties: 'string',
    associations: 'string',
    'max-response-bytes': 'string',
  });
  const object = normalizeObject(positional[0]);
  const id = assertRecordId(positional[1]);
  const httpRequest = buildHttpRequest({
    url: buildUrl(`/crm/v3/objects/${object}/${id}`, {
      properties: parseProperties(flags, object),
      associations: flags.associations,
      archived: false,
    }),
    maxResponseBytes: flags['max-response-bytes']
      ? Number.parseInt(flags['max-response-bytes'], 10)
      : undefined,
  });
  return wrap('get', httpRequest, { object, id });
}

function buildPropertiesRequest(args) {
  const { flags, positional } = parseFlags(args, {
    archived: 'boolean',
    'max-response-bytes': 'string',
  });
  const object = normalizeObject(positional[0]);
  return wrap(
    'properties',
    buildHttpRequest({
      url: buildUrl(`/crm/v3/properties/${object}`, {
        archived: flags.archived === true,
      }),
      maxResponseBytes: flags['max-response-bytes']
        ? Number.parseInt(flags['max-response-bytes'], 10)
        : undefined,
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
  const stage = String(flags.stage || positional.slice(1).join(' ')).trim();
  if (!stage) throw new Error('update-deal-stage requires --stage.');
  if (flags['properties-file']) {
    validatePropertyOptionFromFile({
      filePath: flags['properties-file'],
      propertyName: 'dealstage',
      value: stage,
    });
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
  const stage = String(flags.stage || positional.slice(2).join(' ')).trim();
  if (!stage) throw new Error('update-lifecycle-stage requires --stage.');
  if (flags['properties-file']) {
    validatePropertyOptionFromFile({
      filePath: flags['properties-file'],
      propertyName: 'lifecyclestage',
      value: stage,
    });
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
  if (!associatedObject || !associatedId) return undefined;
  const object = normalizeActivityObject(associatedObject);
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

function planNaturalLanguage(statement) {
  const text = String(statement || '').trim();
  if (!text) throw new Error('plan requires a request.');
  const lower = text.toLowerCase();
  const actions = [];

  const readObject = lower.includes('contact')
    ? 'contacts'
    : lower.includes('compan') || lower.includes('account')
      ? 'companies'
      : lower.includes('deal') || lower.includes('opportunit')
        ? 'deals'
        : null;

  if (/(find|search|show|list|read|get|lookup)/.test(lower) && readObject) {
    actions.push({
      action: 'search-records',
      object: readObject,
      query:
        extractQuoted(text) ||
        extractAfter(lower, ['for ', 'named ', 'called ']) ||
        '',
      stakesTier: 'green',
      requiresEscalation: false,
    });
  }

  const stageMatch = text.match(
    /(?:move|update|set|change)\s+(.+?)\s+(?:deal|opportunity).*?(?:to|stage)\s+["']?([^"']+?)["']?$/i,
  );
  if (stageMatch || lower.includes('deal stage')) {
    actions.push({
      action: 'update-deal-stage',
      deal: stageMatch?.[1]?.trim() || '',
      stage: stageMatch?.[2]?.trim() || '',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: WRITE_GRANTS['update-deal-stage'],
    });
  }

  if (lower.includes('lifecycle')) {
    actions.push({
      action: 'update-lifecycle-stage',
      object: readObject || 'contacts',
      stage:
        extractAfter(lower, ['lifecycle stage to ', 'lifecycle to ', 'to ']) ||
        '',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: WRITE_GRANTS['update-lifecycle-stage'],
    });
  }

  if (/(log|add|create).*(note|timeline note)/.test(lower)) {
    actions.push({
      action: 'create-note',
      targetObject: readObject || 'deals',
      body: extractQuoted(text) || '',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: WRITE_GRANTS['create-note'],
    });
  }

  if (/(create|add|schedule).*(task|todo|follow[- ]?up)/.test(lower)) {
    actions.push({
      action: 'create-task',
      targetObject: readObject || 'contacts',
      subject: extractQuoted(text) || '',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: WRITE_GRANTS['create-task'],
    });
  }

  if (actions.length === 0) {
    actions.push({
      action: 'search-records',
      object: readObject || 'contacts',
      query: extractQuoted(text) || text,
      stakesTier: 'green',
      requiresEscalation: false,
    });
  }

  return {
    command: 'plan',
    statement: text,
    actions,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function validatePropertyOptionFromFile({ filePath, propertyName, value }) {
  const resolved = path.resolve(String(filePath || ''));
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  return validatePropertyOption({
    propertyPayload: payload,
    propertyName,
    value,
  });
}

function validatePropertyOption({ propertyPayload, propertyName, value }) {
  const normalizedProperty = String(propertyName || '').trim();
  const normalizedValue = String(value || '').trim();
  if (!normalizedProperty) throw new Error('Property name is required.');
  if (!normalizedValue) throw new Error('Option value is required.');

  const property = findPropertyPayload(propertyPayload, normalizedProperty);
  if (!property) {
    throw new Error(
      `Property ${normalizedProperty} was not found in HubSpot metadata.`,
    );
  }
  const options = Array.isArray(property.options) ? property.options : [];
  const match = options.find(
    (option) =>
      String(option?.value || '').trim() === normalizedValue ||
      String(option?.label || '').trim() === normalizedValue,
  );
  if (!match) {
    const values = options
      .map((option) => String(option?.value || '').trim())
      .filter(Boolean)
      .slice(0, 20);
    throw new Error(
      `Invalid ${normalizedProperty} value "${normalizedValue}". Valid internal values include: ${values.join(', ') || '(none found)'}.`,
    );
  }
  return {
    propertyName: normalizedProperty,
    value: normalizedValue,
    label: String(match.label || '').trim() || normalizedValue,
    ok: true,
  };
}

function findPropertyPayload(payload, propertyName) {
  if (!payload || typeof payload !== 'object') return null;
  if (
    String(payload.name || '').trim() === propertyName ||
    String(payload.propertyName || '').trim() === propertyName
  ) {
    return payload;
  }
  const results = Array.isArray(payload.results) ? payload.results : [];
  return (
    results.find(
      (entry) =>
        String(entry?.name || '').trim() === propertyName ||
        String(entry?.propertyName || '').trim() === propertyName,
    ) || null
  );
}

function buildValidateOptionCommand(args) {
  const { flags } = parseFlags(args, {
    'properties-file': 'string',
    property: 'string',
    value: 'string',
  });
  if (!flags['properties-file'])
    throw new Error('validate-option requires --properties-file.');
  if (!flags.property) throw new Error('validate-option requires --property.');
  if (!flags.value) throw new Error('validate-option requires --value.');
  return {
    command: 'validate-option',
    ...validatePropertyOptionFromFile({
      filePath: flags['properties-file'],
      propertyName: flags.property,
      value: flags.value,
    }),
    costMeasurement: usageTotalsMeasurement(),
  };
}

function buildWorkflow(statement, args = []) {
  const { flags } = parseFlags(args, {
    'record-id': 'string',
    'associate-id': 'string',
    'associate-object': 'string',
    grant: 'string',
    'operator-grant': 'boolean',
  });
  const plan = planNaturalLanguage(statement);
  const steps = [];
  let stepId = 1;

  for (const action of plan.actions) {
    if (action.action === 'search-records') {
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose: `Search ${action.object}`,
        stakesTier: 'green',
        httpRequest: buildSearchRequest([
          action.object,
          '--query',
          action.query || plan.statement,
          '--limit',
          '10',
        ]).httpRequest,
      });
      continue;
    }

    if (action.action === 'update-deal-stage') {
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose:
          'Read deal properties so the internal dealstage value can be validated before writing.',
        stakesTier: 'green',
        httpRequest: buildPropertiesRequest(['deals']).httpRequest,
      });
      if (!flags['record-id']) {
        steps.push({
          id: `step-${stepId++}`,
          kind: 'http_request',
          purpose: 'Find the target deal ID before updating dealstage.',
          stakesTier: 'green',
          httpRequest: buildSearchRequest([
            'deals',
            '--query',
            action.deal || plan.statement,
            '--limit',
            '10',
          ]).httpRequest,
        });
        steps.push({
          id: `step-${stepId++}`,
          kind: 'operator',
          purpose:
            'Choose exactly one deal ID from the search results, then rerun workflow with --record-id.',
          requiredInput: 'deal record id',
        });
        continue;
      }
      const writeArgs = [
        flags['record-id'],
        '--stage',
        action.stage,
        ...(flags.grant ? ['--grant', flags.grant] : []),
        ...(flags['operator-grant'] ? ['--operator-grant'] : []),
      ];
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose:
          'Update dealstage after the operator confirms the target and validated stage.',
        stakesTier: 'amber',
        requiredGrant: WRITE_GRANTS['update-deal-stage'],
        httpRequest: buildUpdateDealStageRequest(writeArgs).httpRequest,
      });
      continue;
    }

    if (action.action === 'update-lifecycle-stage') {
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose: 'Read lifecycle property options before writing.',
        stakesTier: 'green',
        httpRequest: buildPropertiesRequest([action.object]).httpRequest,
      });
      if (!flags['record-id']) {
        steps.push({
          id: `step-${stepId++}`,
          kind: 'http_request',
          purpose: `Find the target ${action.object} ID before updating lifecyclestage.`,
          stakesTier: 'green',
          httpRequest: buildSearchRequest([
            action.object,
            '--query',
            plan.statement,
            '--limit',
            '10',
          ]).httpRequest,
        });
        steps.push({
          id: `step-${stepId++}`,
          kind: 'operator',
          purpose:
            'Choose exactly one record ID from the search results, then rerun workflow with --record-id.',
          requiredInput: `${action.object} record id`,
        });
        continue;
      }
      const writeArgs = [
        action.object,
        flags['record-id'],
        '--stage',
        action.stage,
        ...(flags.grant ? ['--grant', flags.grant] : []),
        ...(flags['operator-grant'] ? ['--operator-grant'] : []),
      ];
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose:
          'Update lifecyclestage after the operator confirms the target and validated stage.',
        stakesTier: 'amber',
        requiredGrant: WRITE_GRANTS['update-lifecycle-stage'],
        httpRequest: buildUpdateLifecycleStageRequest(writeArgs).httpRequest,
      });
      continue;
    }

    if (action.action === 'create-note') {
      const associatedObject = flags['associate-object'] || action.targetObject;
      if (!flags['associate-id']) {
        steps.push({
          id: `step-${stepId++}`,
          kind: 'http_request',
          purpose: `Find the target ${associatedObject} ID before creating a note.`,
          stakesTier: 'green',
          httpRequest: buildSearchRequest([
            associatedObject,
            '--query',
            plan.statement,
            '--limit',
            '10',
          ]).httpRequest,
        });
        steps.push({
          id: `step-${stepId++}`,
          kind: 'operator',
          purpose:
            'Choose exactly one associated record ID, then rerun workflow with --associate-id.',
          requiredInput: `${associatedObject} record id`,
        });
        continue;
      }
      const noteArgs = [
        '--body',
        action.body || plan.statement,
        '--associate-object',
        associatedObject,
        '--associate-id',
        flags['associate-id'],
        ...(flags.grant ? ['--grant', flags.grant] : []),
        ...(flags['operator-grant'] ? ['--operator-grant'] : []),
      ];
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose: 'Create HubSpot note after target confirmation.',
        stakesTier: 'amber',
        requiredGrant: WRITE_GRANTS['create-note'],
        httpRequest: buildCreateNoteRequest(noteArgs).httpRequest,
      });
      continue;
    }

    if (action.action === 'create-task') {
      const associatedObject = flags['associate-object'] || action.targetObject;
      if (!flags['associate-id']) {
        steps.push({
          id: `step-${stepId++}`,
          kind: 'http_request',
          purpose: `Find the target ${associatedObject} ID before creating a task.`,
          stakesTier: 'green',
          httpRequest: buildSearchRequest([
            associatedObject,
            '--query',
            plan.statement,
            '--limit',
            '10',
          ]).httpRequest,
        });
        steps.push({
          id: `step-${stepId++}`,
          kind: 'operator',
          purpose:
            'Choose exactly one associated record ID, then rerun workflow with --associate-id.',
          requiredInput: `${associatedObject} record id`,
        });
        continue;
      }
      const taskArgs = [
        '--subject',
        action.subject || plan.statement,
        '--associate-object',
        associatedObject,
        '--associate-id',
        flags['associate-id'],
        ...(flags.grant ? ['--grant', flags.grant] : []),
        ...(flags['operator-grant'] ? ['--operator-grant'] : []),
      ];
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose: 'Create HubSpot task after target confirmation.',
        stakesTier: 'amber',
        requiredGrant: WRITE_GRANTS['create-task'],
        httpRequest: buildCreateTaskRequest(taskArgs).httpRequest,
      });
    }
  }

  return {
    command: 'workflow',
    statement: plan.statement,
    actions: plan.actions,
    steps,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function explainErrorPayload(payload) {
  const text = JSON.stringify(payload || {}).toLowerCase();
  const status =
    Number(
      payload?.status || payload?.statusCode || payload?.response?.status,
    ) || null;
  let category = 'upstream-error';
  let operatorMessage =
    'HubSpot returned an error. Inspect the response body and retry only after correcting the request.';
  if (
    status === 401 ||
    text.includes('unauthorized') ||
    text.includes('invalid oauth')
  ) {
    category = 'authentication';
    operatorMessage =
      'HubSpot rejected the OAuth token. Re-run `hybridclaw auth login hubspot` or check that the refresh token is still valid.';
  } else if (
    status === 403 ||
    text.includes('scope') ||
    text.includes('forbidden')
  ) {
    category = 'authorization';
    operatorMessage =
      'HubSpot blocked the request. Check OAuth scopes, app installation, and object permissions.';
  } else if (status === 404 || text.includes('not found')) {
    category = 'not-found';
    operatorMessage =
      'The HubSpot record or endpoint was not found. Re-check object type and record ID.';
  } else if (status === 400 && text.includes('lifecyclestage')) {
    category = 'lifecycle-stage';
    operatorMessage =
      'HubSpot rejected the lifecycle stage update. Verify the internal stage value and lifecycle ordering rules.';
  } else if (
    status === 400 &&
    (text.includes('dealstage') || text.includes('pipeline'))
  ) {
    category = 'deal-stage';
    operatorMessage =
      'HubSpot rejected the deal stage or pipeline value. Read deal properties and use internal option values.';
  } else if (status === 429 || text.includes('rate limit')) {
    category = 'rate-limit';
    operatorMessage =
      'HubSpot rate limited the request. Wait for the retry window before trying again.';
  }
  return {
    command: 'explain-error',
    category,
    status,
    operatorMessage,
    retryable: category === 'rate-limit' || (status !== null && status >= 500),
    costMeasurement: usageTotalsMeasurement(),
  };
}

function buildExplainErrorCommand(args) {
  const { flags, positional } = parseFlags(args, {
    file: 'string',
    status: 'string',
    body: 'string',
  });
  let payload = {};
  if (flags.file) {
    payload = JSON.parse(fs.readFileSync(path.resolve(flags.file), 'utf-8'));
  } else if (flags.body) {
    payload = JSON.parse(flags.body);
  } else if (positional.length > 0) {
    payload = JSON.parse(positional.join(' '));
  }
  if (flags.status) payload.status = Number.parseInt(flags.status, 10);
  return explainErrorPayload(payload);
}

function splitStatementAndFlags(args) {
  const statementParts = [];
  const flagArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      statementParts.push(arg);
      continue;
    }
    flagArgs.push(arg);
    if (arg.includes('=')) continue;
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flagArgs.push(next);
      index += 1;
    }
  }
  return {
    statement: statementParts.join(' ').trim(),
    flagArgs,
  };
}

function extractQuoted(text) {
  const match = text.match(/["']([^"']+)["']/);
  return match?.[1]?.trim() || '';
}

function extractAfter(text, needles) {
  for (const needle of needles) {
    const index = text.indexOf(needle);
    if (index >= 0) return text.slice(index + needle.length).trim();
  }
  return '';
}

function runEvalScenarios() {
  const scenarios = JSON.parse(fs.readFileSync(EVAL_SCENARIOS_PATH, 'utf-8'));
  let failed = 0;
  const categories = {};
  const failures = [];
  for (const scenario of scenarios) {
    categories[scenario.category] = (categories[scenario.category] || 0) + 1;
    const plan = planNaturalLanguage(scenario.input);
    const hasExpected = plan.actions.some(
      (action) => action.action === scenario.expectedAction,
    );
    const costOk = scenario.costMeasurement?.system === 'UsageTotals';
    if (!hasExpected || !costOk) {
      failed += 1;
      failures.push({
        id: scenario.id,
        expectedAction: scenario.expectedAction,
        actualActions: plan.actions.map((action) => action.action),
        costOk,
      });
    }
  }
  return {
    command: 'eval-scenarios',
    scenarioCount: scenarios.length,
    failed,
    categories,
    failures,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function buildHttpRequestCommand(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'list') return buildListRequest(rest);
  if (sub === 'search') return buildSearchRequest(rest);
  if (sub === 'get') return buildGetRequest(rest);
  if (sub === 'properties') return buildPropertiesRequest(rest);
  if (sub === 'update-deal-stage') return buildUpdateDealStageRequest(rest);
  if (sub === 'update-lifecycle-stage')
    return buildUpdateLifecycleStageRequest(rest);
  if (sub === 'create-note') return buildCreateNoteRequest(rest);
  if (sub === 'create-task') return buildCreateTaskRequest(rest);
  throw new Error(`Unknown http-request command: ${sub || '(missing)'}`);
}

function renderText(payload) {
  if (payload.httpRequest) {
    return JSON.stringify(payload, null, 2);
  }
  return JSON.stringify(payload, null, 2);
}

function main() {
  try {
    const global = parseGlobalArgs(process.argv.slice(2));
    if (global.help || global.args.length === 0) {
      printHelp();
      process.exit(0);
    }
    const command = global.args[0];
    const args = global.args.slice(1);
    let payload;
    if (command === 'plan') {
      payload = planNaturalLanguage(args.join(' '));
    } else if (command === 'workflow') {
      const workflow = splitStatementAndFlags(args);
      payload = buildWorkflow(workflow.statement, workflow.flagArgs);
    } else if (command === 'validate-option') {
      payload = buildValidateOptionCommand(args);
    } else if (command === 'explain-error') {
      payload = buildExplainErrorCommand(args);
    } else if (command === 'http-request') {
      payload = buildHttpRequestCommand(args);
    } else if (command === 'eval-scenarios') {
      payload = runEvalScenarios();
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
    process.stdout.write(
      global.format === 'json'
        ? `${JSON.stringify(payload)}\n`
        : `${renderText(payload)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ACTIVITY_ASSOCIATION_TYPE_IDS,
  WRITE_GRANTS,
  buildWorkflow,
  buildHttpRequestCommand,
  explainErrorPayload,
  planNaturalLanguage,
  validatePropertyOption,
  usageTotalsMeasurement,
};
