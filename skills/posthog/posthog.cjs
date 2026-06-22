#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const SKILL_NAME = 'posthog';
const PRIVATE_KEY_SECRET = 'POSTHOG_PERSONAL_API_KEY';
const PROJECT_TOKEN_SECRET = 'POSTHOG_PROJECT_TOKEN';
const HOST_ENV = 'POSTHOG_HOST';
const INGEST_HOST_ENV = 'POSTHOG_INGEST_HOST';
const PROJECT_ID_ENV = 'POSTHOG_PROJECT_ID';
const ENVIRONMENT_ID_ENV = 'POSTHOG_ENVIRONMENT_ID';
const DEFAULT_TIMEOUT_MS = 30_000;
const GATEWAY_TIMEOUT_BUFFER_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4_000_000;
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const DEFAULT_PERSON_LIMIT = 100;
const DEFAULT_FLAG_LIMIT = 100;
const MAX_LIMIT = 500;

const COST_MEASUREMENT = {
  system: 'UsageTotals',
  subLimitKey: 'posthog',
};

const WRITE_GRANTS = {
  'capture-event': 'approve-posthog-event-capture',
  'identify-person': 'approve-posthog-person-property-update',
};

function usage() {
  return `
PostHog skill helper

Build gateway-proxied http_request payloads for PostHog.

Usage:
  node skills/posthog/posthog.cjs [--format json|pretty] plan <request>
  node skills/posthog/posthog.cjs [--format json|pretty] approval-plan capture-event --event <name> --distinct-id <id> [--properties-json <json>]
  node skills/posthog/posthog.cjs [--format json|pretty] approval-plan identify-person --distinct-id <id> --set-json <json>
  node skills/posthog/posthog.cjs [--format json|pretty] run <http-request operation> [operation options]
  node skills/posthog/posthog.cjs [--format json|pretty] http-request capture-event --event <name> --distinct-id <id> [--properties-json <json>] --operator-grant
  node skills/posthog/posthog.cjs [--format json|pretty] http-request identify-person --distinct-id <id> --set-json <json> --operator-grant
  node skills/posthog/posthog.cjs [--format json|pretty] http-request list-persons [--environment-id <id>] [--search <term>] [--distinct-id <id>] [--limit 100]
  node skills/posthog/posthog.cjs [--format json|pretty] http-request get-person --person-id <id> [--environment-id <id>]
  node skills/posthog/posthog.cjs [--format json|pretty] http-request list-feature-flags [--project-id <id>] [--limit 100] [--offset 0]
  node skills/posthog/posthog.cjs [--format json|pretty] http-request get-feature-flag --flag-id <id> [--project-id <id>]
  node skills/posthog/posthog.cjs [--format json|pretty] http-request test-feature-flag --flag-id <id> --distinct-id <id> [--project-id <id>]
  node skills/posthog/posthog.cjs [--format json|pretty] http-request query [--project-id <id>] (--hogql <sql> | --query-json <json>)
  node skills/posthog/posthog.cjs [--format json|pretty] http-request query-status --query-id <id> [--project-id <id>]
  node skills/posthog/posthog.cjs [--format json|pretty] explain-error --payload-file <path>

Global options:
  --format json|pretty           Output JSON. Default: pretty.
  --host <url>                   Private API host. Default: <env:${HOST_ENV}>.
  --ingest-host <url>            Capture API host. Default: <env:${INGEST_HOST_ENV}>.
  --project-id <id>              Private API project id. Default: <env:${PROJECT_ID_ENV}>.
  --environment-id <id>          Persons API environment id. Default: <env:${ENVIRONMENT_ID_ENV}>.
  --timeout-ms <ms>              Gateway request timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --max-response-bytes <n>       Gateway response cap. Default: ${DEFAULT_MAX_RESPONSE_BYTES}.

Write grants:
  ${WRITE_GRANTS['capture-event']}
  ${WRITE_GRANTS['identify-person']}
`.trim();
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const opts = {
    format: 'pretty',
    host: `<env:${HOST_ENV}>`,
    ingestHost: `<env:${INGEST_HOST_ENV}>`,
    projectId: `<env:${PROJECT_ID_ENV}>`,
    environmentId: `<env:${ENVIRONMENT_ID_ENV}>`,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (positional.length > 0) {
      positional.push(arg);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const readValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--format':
        opts.format = readValue();
        break;
      case '--host':
        opts.host = readValue();
        break;
      case '--ingest-host':
        opts.ingestHost = readValue();
        break;
      case '--project-id':
        opts.projectId = readValue();
        break;
      case '--environment-id':
        opts.environmentId = readValue();
        break;
      case '--timeout-ms':
        opts.timeoutMs = parseInteger(readValue(), '--timeout-ms', 1, 600_000);
        break;
      case '--max-response-bytes':
        opts.maxResponseBytes = parseInteger(
          readValue(),
          '--max-response-bytes',
          1,
          50_000_000,
        );
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  if (!['json', 'pretty'].includes(opts.format)) {
    fail('--format must be json or pretty.');
  }

  return {
    opts,
    command: positional[0],
    args: positional.slice(1),
  };
}

function parseCommandArgs(args) {
  const opts = {};
  const rest = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    if (arg === '--operator-grant' || arg === '--async') {
      opts[arg.slice(2)] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`${arg} requires a value.`);
    }
    index += 1;
    const key = arg.slice(2);
    if (opts[key] === undefined) {
      opts[key] = value;
    } else if (Array.isArray(opts[key])) {
      opts[key].push(value);
    } else {
      opts[key] = [opts[key], value];
    }
  }

  return { opts, rest };
}

function parseInteger(raw, label, min, max) {
  if (!/^\d+$/u.test(String(raw))) {
    fail(`${label} must be an integer between ${min} and ${max}.`);
  }
  const value = Number.parseInt(String(raw), 10);
  if (value < min || value > max) {
    fail(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} must be valid JSON: ${error.message}`);
  }
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    fail(`Cannot read JSON file ${filePath}: ${error.message}`);
  }
}

function envPlaceholder(name) {
  return `<env:${name}>`;
}

function secretPlaceholder(name) {
  return `<secret:${name}>`;
}

function resolveGatewayUrl(raw) {
  const value =
    String(raw || '').trim() ||
    String(process.env.HYBRIDCLAW_GATEWAY_URL || '').trim() ||
    String(process.env.GATEWAY_BASE_URL || '').trim() ||
    DEFAULT_GATEWAY_URL;
  const normalized = value.replace(/\/+$/u, '');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    fail('--gateway-url must be an absolute http or https URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail('--gateway-url must use http or https.');
  }
  return normalized;
}

function resolveGatewayToken(raw) {
  return (
    String(raw || '').trim() ||
    String(process.env.HYBRIDCLAW_GATEWAY_TOKEN || '').trim() ||
    String(process.env.GATEWAY_API_TOKEN || '').trim() ||
    String(process.env.WEB_API_TOKEN || '').trim()
  );
}

function popLocalFlag(args, name) {
  const index = args.findIndex(
    (arg) => arg === name || arg.startsWith(`${name}=`),
  );
  if (index === -1) return '';
  const arg = args.splice(index, 1)[0];
  if (arg.includes('=')) return arg.slice(name.length + 1);
  const value = args.splice(index, 1)[0];
  if (value === undefined || value.startsWith('--')) {
    fail(`${name} requires a value.`);
  }
  return value;
}

async function gatewayRequest(httpRequest, { gatewayUrl, gatewayToken }) {
  const url = `${gatewayUrl}/api/http/request`;
  const headers = { 'Content-Type': 'application/json' };
  if (gatewayToken) headers.Authorization = `Bearer ${gatewayToken}`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    (httpRequest.timeoutMs || DEFAULT_TIMEOUT_MS) + GATEWAY_TIMEOUT_BUFFER_MS,
  );
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(httpRequest),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      `Cannot reach HybridClaw gateway at ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let envelope;
  try {
    envelope = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Gateway returned non-JSON response: ${text.slice(0, 500)}`,
    );
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      gatewayError: envelope,
    };
  }
  return envelope;
}

function isEnvPlaceholder(value) {
  return /^<env:[A-Z][A-Z0-9_]{0,127}>$/u.test(String(value));
}

function normalizeBaseUrl(raw, label) {
  const value = String(raw || '').trim().replace(/\/+$/u, '');
  if (!value) fail(`${label} cannot be empty.`);
  if (value.includes('<secret:')) {
    fail(`${label} URL must not contain secret placeholders.`);
  }
  if (value.includes('<env:')) {
    if (!isEnvPlaceholder(value)) {
      fail(`${label} env placeholder must be exactly <env:NAME>.`);
    }
    return value;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an absolute http or https URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail(`${label} must use http or https.`);
  }
  return value;
}

function pathSegment(raw, label) {
  const value = String(raw ?? '').trim();
  if (!value) fail(`${label} is required.`);
  if (isEnvPlaceholder(value)) return value;
  if (value.includes('<secret:')) {
    fail(`${label} must not contain secret placeholders.`);
  }
  return encodeURIComponent(value);
}

function appendPath(base, path) {
  if (isEnvPlaceholder(base)) return `${base}${path}`;
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`;
  return url.toString();
}

function appendQuery(url, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function requiredString(value, label) {
  const text = String(value ?? '').trim();
  if (!text) fail(`${label} is required.`);
  if (text.includes('<secret:')) fail(`${label} must not contain secrets.`);
  return text;
}

function optionalObject(raw, label) {
  if (raw === undefined) return undefined;
  const parsed = parseJson(raw, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${label} must be a JSON object.`);
  }
  return parsed;
}

function requestEnvelope({ operation, stakesTier, httpRequest, notes = [] }) {
  return {
    command: 'http-request',
    operation,
    stakesTier,
    httpRequest,
    costMeasurement: COST_MEASUREMENT,
    notes,
  };
}

function baseHttpRequest(opts, url, method = 'GET') {
  return {
    url,
    method,
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes,
    skillName: SKILL_NAME,
  };
}

function privateRequest(opts, path, method = 'GET', params = {}) {
  const host = normalizeBaseUrl(opts.host, '--host');
  const url = appendQuery(appendPath(host, path), params);
  return {
    ...baseHttpRequest(opts, url, method),
    bearerSecretName: PRIVATE_KEY_SECRET,
  };
}

function requireGrant(cmdOpts, operation) {
  if (!cmdOpts['operator-grant']) {
    fail(
      `Refusing PostHog write without --operator-grant (${WRITE_GRANTS[operation]}). ` +
        'Run approval-plan first and get explicit operator confirmation.',
    );
  }
}

function buildCaptureEvent(globalOpts, cmdOpts) {
  requireGrant(cmdOpts, 'capture-event');
  const ingestHost = normalizeBaseUrl(globalOpts.ingestHost, '--ingest-host');
  const event = requiredString(cmdOpts.event, '--event');
  const distinctId = requiredString(cmdOpts['distinct-id'], '--distinct-id');
  const properties = optionalObject(cmdOpts['properties-json'], '--properties-json') || {};
  const timestamp = cmdOpts.timestamp
    ? requiredString(cmdOpts.timestamp, '--timestamp')
    : undefined;

  const json = {
    api_key: secretPlaceholder(PROJECT_TOKEN_SECRET),
    event,
    distinct_id: distinctId,
    properties,
  };
  if (timestamp) json.timestamp = timestamp;

  return requestEnvelope({
    operation: 'capture-event',
    stakesTier: 'amber',
    httpRequest: {
      ...baseHttpRequest(globalOpts, appendPath(ingestHost, '/capture/'), 'POST'),
      json,
      replaceSecretPlaceholders: true,
    },
    notes: [
      'Capture payload includes user-supplied event properties; do not include secrets or raw sensitive text.',
    ],
  });
}

function buildIdentifyPerson(globalOpts, cmdOpts) {
  requireGrant(cmdOpts, 'identify-person');
  const ingestHost = normalizeBaseUrl(globalOpts.ingestHost, '--ingest-host');
  const distinctId = requiredString(cmdOpts['distinct-id'], '--distinct-id');
  const setProperties = optionalObject(cmdOpts['set-json'], '--set-json');
  const setOnceProperties = optionalObject(
    cmdOpts['set-once-json'],
    '--set-once-json',
  );
  if (!setProperties && !setOnceProperties) {
    fail('identify-person requires --set-json or --set-once-json.');
  }

  const properties = {};
  if (setProperties) properties.$set = setProperties;
  if (setOnceProperties) properties.$set_once = setOnceProperties;

  return requestEnvelope({
    operation: 'identify-person',
    stakesTier: 'amber',
    httpRequest: {
      ...baseHttpRequest(globalOpts, appendPath(ingestHost, '/capture/'), 'POST'),
      json: {
        api_key: secretPlaceholder(PROJECT_TOKEN_SECRET),
        event: '$identify',
        distinct_id: distinctId,
        properties,
      },
      replaceSecretPlaceholders: true,
    },
    notes: [
      'Person property update is sent as a PostHog $identify event through the capture API.',
    ],
  });
}

function buildListPersons(globalOpts, cmdOpts) {
  const environmentId = pathSegment(
    cmdOpts['environment-id'] || globalOpts.environmentId,
    '--environment-id',
  );
  const params = {
    limit: parseInteger(
      cmdOpts.limit || DEFAULT_PERSON_LIMIT,
      '--limit',
      1,
      MAX_LIMIT,
    ),
  };
  if (cmdOpts.search) params.search = requiredString(cmdOpts.search, '--search');
  if (cmdOpts['distinct-id']) {
    params.distinct_id = requiredString(cmdOpts['distinct-id'], '--distinct-id');
  }
  if (cmdOpts.offset) params.offset = requiredString(cmdOpts.offset, '--offset');

  return requestEnvelope({
    operation: 'list-persons',
    stakesTier: 'green',
    httpRequest: privateRequest(
      globalOpts,
      `/api/environments/${environmentId}/persons/`,
      'GET',
      params,
    ),
  });
}

function buildGetPerson(globalOpts, cmdOpts) {
  const environmentId = pathSegment(
    cmdOpts['environment-id'] || globalOpts.environmentId,
    '--environment-id',
  );
  const personId = pathSegment(cmdOpts['person-id'], '--person-id');
  return requestEnvelope({
    operation: 'get-person',
    stakesTier: 'green',
    httpRequest: privateRequest(
      globalOpts,
      `/api/environments/${environmentId}/persons/${personId}/`,
    ),
  });
}

function buildListFeatureFlags(globalOpts, cmdOpts) {
  const projectId = pathSegment(
    cmdOpts['project-id'] || globalOpts.projectId,
    '--project-id',
  );
  const params = {
    limit: parseInteger(
      cmdOpts.limit || DEFAULT_FLAG_LIMIT,
      '--limit',
      1,
      MAX_LIMIT,
    ),
  };
  if (cmdOpts.offset) params.offset = requiredString(cmdOpts.offset, '--offset');
  if (cmdOpts.search) params.search = requiredString(cmdOpts.search, '--search');

  return requestEnvelope({
    operation: 'list-feature-flags',
    stakesTier: 'green',
    httpRequest: privateRequest(
      globalOpts,
      `/api/projects/${projectId}/feature_flags/`,
      'GET',
      params,
    ),
  });
}

function buildGetFeatureFlag(globalOpts, cmdOpts) {
  const projectId = pathSegment(
    cmdOpts['project-id'] || globalOpts.projectId,
    '--project-id',
  );
  const flagId = pathSegment(cmdOpts['flag-id'], '--flag-id');
  return requestEnvelope({
    operation: 'get-feature-flag',
    stakesTier: 'green',
    httpRequest: privateRequest(
      globalOpts,
      `/api/projects/${projectId}/feature_flags/${flagId}/`,
    ),
  });
}

function buildTestFeatureFlag(globalOpts, cmdOpts) {
  const projectId = pathSegment(
    cmdOpts['project-id'] || globalOpts.projectId,
    '--project-id',
  );
  const flagId = pathSegment(cmdOpts['flag-id'], '--flag-id');
  const json = {
    distinct_id: requiredString(cmdOpts['distinct-id'], '--distinct-id'),
  };
  const groups = optionalObject(cmdOpts['groups-json'], '--groups-json');
  if (groups) json.groups = groups;
  if (cmdOpts['person-id']) json.person_id = requiredString(cmdOpts['person-id'], '--person-id');

  return requestEnvelope({
    operation: 'test-feature-flag',
    stakesTier: 'green',
    httpRequest: {
      ...privateRequest(
        globalOpts,
        `/api/projects/${projectId}/feature_flags/${flagId}/test/`,
        'POST',
      ),
      json,
    },
    notes: ['Test evaluation does not create or update the feature flag.'],
  });
}

function buildQuery(globalOpts, cmdOpts) {
  const projectId = pathSegment(
    cmdOpts['project-id'] || globalOpts.projectId,
    '--project-id',
  );
  let query;
  if (cmdOpts.hogql) {
    query = {
      kind: 'HogQLQuery',
      query: requiredString(cmdOpts.hogql, '--hogql'),
    };
  } else if (cmdOpts['query-json']) {
    query = parseJson(cmdOpts['query-json'], '--query-json');
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      fail('--query-json must be a JSON object.');
    }
  } else {
    fail('query requires --hogql or --query-json.');
  }

  const params = {};
  if (cmdOpts.async) params.async = 'true';

  return requestEnvelope({
    operation: 'query',
    stakesTier: 'green',
    httpRequest: {
      ...privateRequest(
        globalOpts,
        `/api/projects/${projectId}/query/`,
        'POST',
        params,
      ),
      json: { query },
    },
  });
}

function buildQueryStatus(globalOpts, cmdOpts) {
  const projectId = pathSegment(
    cmdOpts['project-id'] || globalOpts.projectId,
    '--project-id',
  );
  const queryId = pathSegment(cmdOpts['query-id'], '--query-id');
  return requestEnvelope({
    operation: 'query-status',
    stakesTier: 'green',
    httpRequest: privateRequest(
      globalOpts,
      `/api/projects/${projectId}/query/${queryId}/`,
    ),
  });
}

function buildHttpRequest(globalOpts, args) {
  const operation = args[0];
  const { opts: cmdOpts } = parseCommandArgs(args.slice(1));

  switch (operation) {
    case 'capture-event':
      return buildCaptureEvent(globalOpts, cmdOpts);
    case 'identify-person':
      return buildIdentifyPerson(globalOpts, cmdOpts);
    case 'list-persons':
      return buildListPersons(globalOpts, cmdOpts);
    case 'get-person':
      return buildGetPerson(globalOpts, cmdOpts);
    case 'list-feature-flags':
      return buildListFeatureFlags(globalOpts, cmdOpts);
    case 'get-feature-flag':
      return buildGetFeatureFlag(globalOpts, cmdOpts);
    case 'test-feature-flag':
      return buildTestFeatureFlag(globalOpts, cmdOpts);
    case 'query':
      return buildQuery(globalOpts, cmdOpts);
    case 'query-status':
      return buildQueryStatus(globalOpts, cmdOpts);
    default:
      fail(`Unknown http-request operation: ${operation || '(missing)'}`);
  }
}

async function buildRun(globalOpts, args) {
  const localArgs = [...args];
  const gatewayUrl = resolveGatewayUrl(popLocalFlag(localArgs, '--gateway-url'));
  const gatewayToken = resolveGatewayToken(
    popLocalFlag(localArgs, '--gateway-token'),
  );
  const requestPayload = buildHttpRequest(globalOpts, localArgs);
  const response = await gatewayRequest(requestPayload.httpRequest, {
    gatewayUrl,
    gatewayToken,
  });
  const interpretedError = interpretPostHogError(response);

  return {
    command: 'run',
    operation: requestPayload.operation,
    stakesTier: requestPayload.stakesTier,
    response,
    ...(interpretedError ? { interpretedError } : {}),
    costMeasurement: COST_MEASUREMENT,
    liveExecution: {
      gatewayUrl,
      skillName: SKILL_NAME,
    },
  };
}

function buildApprovalPlan(args) {
  const operation = args[0];
  if (!WRITE_GRANTS[operation]) {
    fail(`approval-plan only supports guarded writes: ${Object.keys(WRITE_GRANTS).join(', ')}.`);
  }
  const rest = args.slice(1);
  const grant = WRITE_GRANTS[operation];
  return {
    command: 'approval-plan',
    operation,
    stakesTier: 'amber',
    requiredGrant: grant,
    approvalQuestion:
      operation === 'capture-event'
        ? 'Approve sending this single analytics event to PostHog?'
        : 'Approve updating these PostHog person properties?',
    approvedCommand: [
      'node',
      'skills/posthog/posthog.cjs',
      '--format',
      'json',
      'http-request',
      operation,
      ...rest,
      '--operator-grant',
    ],
    notes: [
      'Run the approved command unchanged only after explicit operator confirmation.',
      'Do not include secrets, credentials, contracts, or raw support transcripts in PostHog properties.',
    ],
  };
}

function planNaturalLanguage(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) fail('plan requires a request string.');

  const isPostHog = /\b(posthog|product analytics|feature flags?|persons?|hogql|funnels?|trends?|retention|events?)\b/u.test(
    normalized,
  );
  const wantsFlagChange = /\b(create|update|edit|delete|remove|roll\s*out|rollout|enable|disable|archive)\b/u.test(
    normalized,
  ) && /\b(feature flags?|flags?)\b/u.test(normalized);
  const wantsPersonDelete = /\b(delete|remove|erase)\b/u.test(normalized) &&
    /\b(person|user|profile)\b/u.test(normalized);
  const wantsWrite = /\b(capture|track|send|identify|set|update)\b/u.test(
    normalized,
  );
  const wantsQuery = /\b(query|hogql|sql|trend|funnel|retention|dashboard|insight|count|conversion)\b/u.test(
    normalized,
  );
  const wantsFlagRead = /\b(feature flags?|flags?)\b/u.test(normalized);
  const wantsPersonRead = /\b(person|user|profile|distinct id|distinct_id)\b/u.test(
    normalized,
  );

  if (wantsFlagChange || wantsPersonDelete) {
    return {
      command: 'plan',
      domain: isPostHog ? 'posthog' : 'unknown',
      operation: wantsFlagChange ? 'feature-flag-mutation' : 'person-delete',
      stakesTier: 'red',
      supported: false,
      reason: 'This skill does not create/update/delete feature flags or delete persons.',
    };
  }

  if (wantsWrite) {
    const operation = normalized.includes('identify') || normalized.includes('person')
      ? 'identify-person'
      : 'capture-event';
    return {
      command: 'plan',
      domain: isPostHog ? 'posthog' : 'unknown',
      operation,
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: WRITE_GRANTS[operation],
    };
  }

  return {
    command: 'plan',
    domain: isPostHog ? 'posthog' : 'unknown',
    operation: wantsQuery
      ? 'query'
      : wantsFlagRead
        ? 'feature-flag-read'
        : wantsPersonRead
          ? 'person-read'
          : 'read',
    stakesTier: 'green',
    requiresEscalation: false,
  };
}

function explainError(payload) {
  return {
    command: 'explain-error',
    ...interpretPostHogError(payload, { fallback: true }),
  };
}

function interpretPostHogError(payload, options = {}) {
  const text = JSON.stringify(payload || {}).toLowerCase();
  const status = Number(
    payload?.status ||
      payload?.statusCode ||
      payload?.response?.status ||
      payload?.httpStatus,
  ) || null;
  let category = 'upstream-error';
  let operatorMessage =
    'PostHog returned an error. Inspect the response and retry only after correcting the request.';

  if (status === 401 || text.includes('unauthorized') || text.includes('invalid token')) {
    category = 'authentication';
    operatorMessage =
      'PostHog rejected the stored credential. Stop after this failed call and ask the operator to verify POSTHOG_PROJECT_TOKEN for capture calls or POSTHOG_PERSONAL_API_KEY for private API calls.';
  } else if (status === 403 || text.includes('forbidden') || text.includes('permission')) {
    category = 'authorization';
    operatorMessage =
      'PostHog blocked the request. Verify personal API key scopes, project access, and environment access.';
  } else if (status === 404 || text.includes('not found')) {
    category = 'not-found';
    operatorMessage =
      'The PostHog project, environment, person, feature flag, query, or endpoint was not found. Re-check ids and regional host configuration.';
  } else if (
    text.includes('secret') &&
    (text.includes('missing') ||
      text.includes('not set') ||
      text.includes('unavailable') ||
      text.includes('unresolved'))
  ) {
    category = 'missing-secret';
    operatorMessage =
      'The active HybridClaw gateway could not resolve a required PostHog stored secret. Set it with /secret set or hybridclaw secret set in the same runtime.';
  } else if (status === 400 || text.includes('validation')) {
    category = 'validation';
    operatorMessage =
      'PostHog rejected the request shape. Rebuild the helper command with valid ids, payload JSON, and query kind.';
  } else if (status === 429 || text.includes('rate limit')) {
    category = 'rate-limit';
    operatorMessage =
      'PostHog rate-limited the request. Wait for the reset window before retrying.';
  } else if (text.includes('policy') || text.includes('allowlist')) {
    category = 'gateway-policy';
    operatorMessage =
      'HybridClaw gateway policy blocked this PostHog host or secret injection path. Fix policy/configuration instead of changing the helper request.';
  } else if (!options.fallback) {
    return null;
  }

  return {
    category,
    status,
    operatorMessage,
    retryable: category === 'rate-limit' || (status !== null && status >= 500),
  };
}

function print(payload, format) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.opts.help || !parsed.command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let payload;
  switch (parsed.command) {
    case 'plan':
      payload = planNaturalLanguage(parsed.args.join(' '));
      break;
    case 'approval-plan':
      payload = buildApprovalPlan(parsed.args);
      break;
    case 'run':
      payload = await buildRun(parsed.opts, parsed.args);
      break;
    case 'http-request':
      payload = buildHttpRequest(parsed.opts, parsed.args);
      break;
    case 'explain-error': {
      const { opts } = parseCommandArgs(parsed.args);
      if (!opts['payload-file']) fail('explain-error requires --payload-file.');
      payload = explainError(loadJsonFile(opts['payload-file']));
      break;
    }
    default:
      fail(`Unknown command: ${parsed.command}`);
  }

  print(payload, parsed.opts.format);
}

try {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}
