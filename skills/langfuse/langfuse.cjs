#!/usr/bin/env node
'use strict';

const path = require('node:path');

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const DEFAULT_TIMEOUT_MS = 30_000;
const GATEWAY_TIMEOUT_BUFFER_MS = 5_000;
const BASIC_AUTH_SECRET = 'LANGFUSE_BASIC_AUTH';
const HOST_ENV = 'LANGFUSE_HOST';
const HOST_PLACEHOLDER = `<env:${HOST_ENV}>`;
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');

const COST_MEASUREMENT = {
  system: 'UsageTotals',
  source: 'HybridClaw usage_events',
  scope: 'per assistant run/session',
};

const LIVE_EXECUTION = {
  mode: 'live-langfuse-api',
  requiresConfiguredSecrets: [BASIC_AUTH_SECRET],
  requiresConfiguredEnv: [HOST_ENV],
  dryRunSafe:
    'For prompt/user testing, use http-request and stop after producing this payload; do not call run or http_request.',
  approvalPolicy:
    'Writes that create scores, comments, datasets, dataset items, or prompt versions require an explicit operator approval before --operator-grant may be used.',
  callPolicy:
    'Use this CJS helper as the API wrapper. For real user requests that need live Langfuse data, use the run command so the helper calls the gateway and the gateway injects the Basic auth header server-side.',
  secretRefPolicy:
    'Do not preflight, inspect, print, or ask the model for LANGFUSE_BASIC_AUTH. The Authorization header carries a <secret:LANGFUSE_BASIC_AUTH> placeholder that the gateway resolves.',
  requestShape:
    'Do not handcraft Langfuse API calls. The helper owns the endpoint, method, payload, tier, host, and Basic auth placeholder.',
  unauthorizedPolicy:
    'If a live call returns 401 or 403, stop after the first failure. Do not retry or call additional Langfuse endpoints; ask the operator to set or verify LANGFUSE_BASIC_AUTH and LANGFUSE_HOST.',
};

const OPERATION_TIERS = {
  health: 'green',
  'get-project': 'green',
  'list-traces': 'green',
  'get-trace': 'green',
  'list-observations': 'green',
  'get-observation': 'green',
  'list-sessions': 'green',
  'get-session': 'green',
  'list-scores': 'green',
  'get-score': 'green',
  'list-score-configs': 'green',
  'get-score-config': 'green',
  'list-prompts': 'green',
  'get-prompt': 'green',
  'list-datasets': 'green',
  'get-dataset': 'green',
  'list-dataset-items': 'green',
  'get-dataset-item': 'green',
  'list-dataset-runs': 'green',
  'get-dataset-run': 'green',
  'list-models': 'green',
  'get-model': 'green',
  'list-comments': 'green',
  'get-comment': 'green',
  metrics: 'green',
  'create-score': 'amber',
  'create-comment': 'amber',
  'create-dataset': 'amber',
  'create-dataset-item': 'amber',
  'create-prompt': 'amber',
};
const HTTP_OPERATIONS = new Set(Object.keys(OPERATION_TIERS));

function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function popFlag(args, name, fallback = undefined, options = {}) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || (!options.allowDashValue && value.startsWith('--'))) {
    die(`${name} requires a value.`);
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
      die(`${name} requires a value.`);
    }
    values.push(value);
    args.splice(index, 2);
    index = args.indexOf(name);
  }
  return values;
}

function popBoolean(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function requireText(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function parsePositiveInteger(raw, label) {
  if (!/^\d+$/.test(String(raw ?? ''))) {
    die(`${label} must be a positive integer.`);
  }
  return Number.parseInt(raw, 10);
}

function parseNumber(raw, label) {
  const value = Number(raw);
  if (!Number.isFinite(value)) die(`${label} must be a number.`);
  return value;
}

function parseJsonFlag(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    die(`${label} must be valid JSON.`);
  }
}

function encodeSegment(value, label) {
  return encodeURIComponent(requireText(value, label));
}

function appendQuery(url, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null || entry === '') continue;
        query.append(key, String(entry));
      }
      continue;
    }
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${url}?${text}` : url;
}

function assertNoUnexpectedArgs(args) {
  if (args.length > 0) {
    die(`Unexpected arguments: ${args.join(' ')}`);
  }
}

function requireSecretName(value, label) {
  const secretName = requireText(value, label);
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(secretName)) {
    die(`${label} must be an uppercase runtime secret name.`);
  }
  return secretName;
}

function requireGrant(args, operation) {
  if (OPERATION_TIERS[operation] === 'green') return false;
  const granted = popBoolean(args, '--operator-grant');
  if (!granted) {
    die(
      `Refusing Langfuse ${operation} without --operator-grant. ` +
        'Run plan/read first and get an explicit operator grant.',
    );
  }
  return true;
}

function resolveBaseUrl(args) {
  const raw = popFlag(args, '--host');
  if (raw === undefined) return HOST_PLACEHOLDER;
  const host = requireText(raw, '--host');
  let parsed;
  try {
    parsed = new URL(host);
  } catch {
    die('--host must be an absolute https URL, e.g. https://cloud.langfuse.com.');
  }
  if (parsed.protocol !== 'https:') {
    die('--host must use https.');
  }
  return host.replace(/\/+$/u, '');
}

function resolveAuthSecret(args) {
  return requireSecretName(
    popFlag(args, '--basic-auth-secret', BASIC_AUTH_SECRET),
    '--basic-auth-secret',
  );
}

function buildHttpRequest(operation, { base, secretName, url, method = 'GET', json }) {
  const payload = {
    command: 'http-request',
    operation,
    stakesTier: OPERATION_TIERS[operation],
    httpRequest: {
      url: `${base}${url}`,
      method,
      headers: {
        Authorization: `Basic <secret:${secretName}>`,
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      skillName: 'langfuse',
      stakesTier: OPERATION_TIERS[operation],
    },
    costMeasurement: COST_MEASUREMENT,
    liveExecution: LIVE_EXECUTION,
  };
  if (json !== undefined) payload.httpRequest.json = json;
  return payload;
}

function parsePagination(args, query) {
  const page = popFlag(args, '--page');
  if (page !== undefined) query.page = parsePositiveInteger(page, '--page');
  const limit = popFlag(args, '--limit');
  if (limit !== undefined) {
    const value = parsePositiveInteger(limit, '--limit');
    if (value > 100) {
      die('--limit cannot exceed 100 (Langfuse page-size cap); use --page to paginate.');
    }
    query.limit = value;
  }
  const cursor = popFlag(args, '--cursor');
  if (cursor !== undefined) query.cursor = cursor;
}

function buildScoreBody(args) {
  const targets = {
    traceId: popFlag(args, '--trace-id'),
    observationId: popFlag(args, '--observation-id'),
    sessionId: popFlag(args, '--session-id'),
    datasetRunId: popFlag(args, '--dataset-run-id'),
  };
  const selected = Object.entries(targets).filter(([, value]) => value !== undefined);
  if (selected.length === 0) {
    die(
      'create-score requires one of --trace-id, --observation-id, --session-id, or --dataset-run-id.',
    );
  }
  if (selected.length > 1) {
    die('create-score accepts only one score target.');
  }
  const name = requireText(popFlag(args, '--name'), '--name');
  const dataType = popFlag(args, '--data-type', 'NUMERIC');
  if (!['NUMERIC', 'CATEGORICAL', 'BOOLEAN'].includes(dataType)) {
    die('--data-type must be NUMERIC, CATEGORICAL, or BOOLEAN.');
  }
  const rawValue = requireText(popFlag(args, '--value'), '--value');
  const body = {
    name,
    dataType,
    value: dataType === 'CATEGORICAL' ? rawValue : parseNumber(rawValue, '--value'),
    [selected[0][0]]: selected[0][1],
  };
  const comment = popFlag(args, '--comment', undefined, { allowDashValue: true });
  if (comment !== undefined) body.comment = comment;
  const configId = popFlag(args, '--config-id');
  if (configId !== undefined) body.configId = configId;
  const environment = popFlag(args, '--environment');
  if (environment !== undefined) body.environment = environment;
  const id = popFlag(args, '--id');
  if (id !== undefined) body.id = id;
  return body;
}

function commandHttpRequest(args) {
  const operation = args.shift();
  if (!operation) die('http-request requires an operation.');
  if (!HTTP_OPERATIONS.has(operation)) {
    die(`Unknown Langfuse operation: ${operation}`);
  }
  const base = resolveBaseUrl(args);
  const secretName = resolveAuthSecret(args);
  requireGrant(args, operation);
  const build = (config) =>
    buildHttpRequest(operation, { base, secretName, ...config });

  let payload;
  switch (operation) {
    case 'health':
      payload = build({ url: '/api/public/health' });
      break;
    case 'get-project':
      payload = build({ url: '/api/public/projects' });
      break;
    case 'list-traces': {
      const query = {};
      parsePagination(args, query);
      query.userId = popFlag(args, '--user-id');
      query.name = popFlag(args, '--name');
      query.sessionId = popFlag(args, '--session-id');
      query.fromTimestamp = popFlag(args, '--from-timestamp');
      query.toTimestamp = popFlag(args, '--to-timestamp');
      query.environment = popRepeatedFlag(args, '--environment');
      query.tags = popRepeatedFlag(args, '--tag');
      query.version = popFlag(args, '--version');
      query.release = popFlag(args, '--release');
      query.orderBy = popFlag(args, '--order-by');
      payload = build({ url: appendQuery('/api/public/traces', query) });
      break;
    }
    case 'get-trace':
      payload = build({
        url: `/api/public/traces/${encodeSegment(popFlag(args, '--trace-id'), '--trace-id')}`,
      });
      break;
    case 'list-observations': {
      const query = {};
      parsePagination(args, query);
      query.name = popFlag(args, '--name');
      query.userId = popFlag(args, '--user-id');
      query.type = popFlag(args, '--type');
      query.traceId = popFlag(args, '--trace-id');
      query.parentObservationId = popFlag(args, '--parent-observation-id');
      query.fromStartTime = popFlag(args, '--from-start-time');
      query.toStartTime = popFlag(args, '--to-start-time');
      query.environment = popRepeatedFlag(args, '--environment');
      query.version = popFlag(args, '--version');
      payload = build({ url: appendQuery('/api/public/observations', query) });
      break;
    }
    case 'get-observation':
      payload = build({
        url: `/api/public/observations/${encodeSegment(popFlag(args, '--observation-id'), '--observation-id')}`,
      });
      break;
    case 'list-sessions': {
      const query = {};
      parsePagination(args, query);
      query.fromTimestamp = popFlag(args, '--from-timestamp');
      query.toTimestamp = popFlag(args, '--to-timestamp');
      query.environment = popRepeatedFlag(args, '--environment');
      payload = build({ url: appendQuery('/api/public/sessions', query) });
      break;
    }
    case 'get-session':
      payload = build({
        url: `/api/public/sessions/${encodeSegment(popFlag(args, '--session-id'), '--session-id')}`,
      });
      break;
    case 'list-scores': {
      const query = {};
      parsePagination(args, query);
      query.userId = popFlag(args, '--user-id');
      query.name = popFlag(args, '--name');
      query.fromTimestamp = popFlag(args, '--from-timestamp');
      query.toTimestamp = popFlag(args, '--to-timestamp');
      query.source = popFlag(args, '--source');
      query.dataType = popFlag(args, '--data-type');
      query.configId = popFlag(args, '--config-id');
      query.environment = popRepeatedFlag(args, '--environment');
      payload = build({ url: appendQuery('/api/public/v2/scores', query) });
      break;
    }
    case 'get-score':
      payload = build({
        url: `/api/public/v2/scores/${encodeSegment(popFlag(args, '--score-id'), '--score-id')}`,
      });
      break;
    case 'list-score-configs': {
      const query = {};
      parsePagination(args, query);
      payload = build({ url: appendQuery('/api/public/score-configs', query) });
      break;
    }
    case 'get-score-config':
      payload = build({
        url: `/api/public/score-configs/${encodeSegment(popFlag(args, '--config-id'), '--config-id')}`,
      });
      break;
    case 'list-prompts': {
      const query = {};
      parsePagination(args, query);
      query.name = popFlag(args, '--name');
      query.label = popFlag(args, '--label');
      query.tag = popFlag(args, '--tag');
      query.fromUpdatedAt = popFlag(args, '--from-updated-at');
      query.toUpdatedAt = popFlag(args, '--to-updated-at');
      payload = build({ url: appendQuery('/api/public/v2/prompts', query) });
      break;
    }
    case 'get-prompt': {
      const query = {};
      const version = popFlag(args, '--version');
      if (version !== undefined) query.version = parsePositiveInteger(version, '--version');
      query.label = popFlag(args, '--label');
      payload = build({
        url: appendQuery(
          `/api/public/v2/prompts/${encodeSegment(popFlag(args, '--prompt-name'), '--prompt-name')}`,
          query,
        ),
      });
      break;
    }
    case 'list-datasets': {
      const query = {};
      parsePagination(args, query);
      payload = build({ url: appendQuery('/api/public/v2/datasets', query) });
      break;
    }
    case 'get-dataset':
      payload = build({
        url: `/api/public/v2/datasets/${encodeSegment(popFlag(args, '--dataset-name'), '--dataset-name')}`,
      });
      break;
    case 'list-dataset-items': {
      const query = {};
      parsePagination(args, query);
      query.datasetName = popFlag(args, '--dataset-name');
      query.sourceTraceId = popFlag(args, '--source-trace-id');
      query.sourceObservationId = popFlag(args, '--source-observation-id');
      payload = build({ url: appendQuery('/api/public/dataset-items', query) });
      break;
    }
    case 'get-dataset-item':
      payload = build({
        url: `/api/public/dataset-items/${encodeSegment(popFlag(args, '--item-id'), '--item-id')}`,
      });
      break;
    case 'list-dataset-runs': {
      const datasetName = encodeSegment(popFlag(args, '--dataset-name'), '--dataset-name');
      const query = {};
      parsePagination(args, query);
      payload = build({
        url: appendQuery(`/api/public/datasets/${datasetName}/runs`, query),
      });
      break;
    }
    case 'get-dataset-run': {
      const datasetName = encodeSegment(popFlag(args, '--dataset-name'), '--dataset-name');
      const runName = encodeSegment(popFlag(args, '--run-name'), '--run-name');
      payload = build({
        url: `/api/public/datasets/${datasetName}/runs/${runName}`,
      });
      break;
    }
    case 'list-models': {
      const query = {};
      parsePagination(args, query);
      payload = build({ url: appendQuery('/api/public/models', query) });
      break;
    }
    case 'get-model':
      payload = build({
        url: `/api/public/models/${encodeSegment(popFlag(args, '--model-id'), '--model-id')}`,
      });
      break;
    case 'list-comments': {
      const query = {};
      parsePagination(args, query);
      query.objectType = popFlag(args, '--object-type');
      query.objectId = popFlag(args, '--object-id');
      query.authorUserId = popFlag(args, '--author-user-id');
      payload = build({ url: appendQuery('/api/public/comments', query) });
      break;
    }
    case 'get-comment':
      payload = build({
        url: `/api/public/comments/${encodeSegment(popFlag(args, '--comment-id'), '--comment-id')}`,
      });
      break;
    case 'metrics': {
      const queryJson = requireText(popFlag(args, '--query'), '--query');
      parseJsonFlag(queryJson, '--query');
      payload = build({
        url: appendQuery('/api/public/metrics', { query: queryJson }),
      });
      break;
    }
    case 'create-score':
      payload = build({
        url: '/api/public/scores',
        method: 'POST',
        json: buildScoreBody(args),
      });
      break;
    case 'create-comment': {
      const objectType = requireText(popFlag(args, '--object-type'), '--object-type');
      if (!['TRACE', 'OBSERVATION', 'SESSION', 'PROMPT'].includes(objectType)) {
        die('--object-type must be TRACE, OBSERVATION, SESSION, or PROMPT.');
      }
      const json = {
        objectType,
        objectId: requireText(popFlag(args, '--object-id'), '--object-id'),
        content: requireText(
          popFlag(args, '--content', undefined, { allowDashValue: true }),
          '--content',
        ),
      };
      const authorUserId = popFlag(args, '--author-user-id');
      if (authorUserId !== undefined) json.authorUserId = authorUserId;
      payload = build({ url: '/api/public/comments', method: 'POST', json });
      break;
    }
    case 'create-dataset': {
      const json = { name: requireText(popFlag(args, '--name'), '--name') };
      const description = popFlag(args, '--description', undefined, {
        allowDashValue: true,
      });
      if (description !== undefined) json.description = description;
      const metadata = popFlag(args, '--metadata-json');
      if (metadata !== undefined) json.metadata = parseJsonFlag(metadata, '--metadata-json');
      payload = build({ url: '/api/public/v2/datasets', method: 'POST', json });
      break;
    }
    case 'create-dataset-item': {
      const json = {
        datasetName: requireText(popFlag(args, '--dataset-name'), '--dataset-name'),
      };
      const input = popFlag(args, '--input-json');
      if (input !== undefined) json.input = parseJsonFlag(input, '--input-json');
      const expected = popFlag(args, '--expected-output-json');
      if (expected !== undefined) {
        json.expectedOutput = parseJsonFlag(expected, '--expected-output-json');
      }
      const metadata = popFlag(args, '--metadata-json');
      if (metadata !== undefined) json.metadata = parseJsonFlag(metadata, '--metadata-json');
      const sourceTraceId = popFlag(args, '--source-trace-id');
      if (sourceTraceId !== undefined) json.sourceTraceId = sourceTraceId;
      const sourceObservationId = popFlag(args, '--source-observation-id');
      if (sourceObservationId !== undefined) {
        json.sourceObservationId = sourceObservationId;
      }
      const id = popFlag(args, '--id');
      if (id !== undefined) json.id = id;
      const status = popFlag(args, '--status');
      if (status !== undefined) {
        if (!['ACTIVE', 'ARCHIVED'].includes(status)) {
          die('--status must be ACTIVE or ARCHIVED.');
        }
        json.status = status;
      }
      payload = build({ url: '/api/public/dataset-items', method: 'POST', json });
      break;
    }
    case 'create-prompt': {
      const type = popFlag(args, '--type', 'text');
      if (!['text', 'chat'].includes(type)) {
        die('--type must be text or chat.');
      }
      const json = {
        type,
        name: requireText(popFlag(args, '--name'), '--name'),
      };
      if (type === 'chat') {
        json.prompt = parseJsonFlag(
          requireText(popFlag(args, '--prompt-json'), '--prompt-json'),
          '--prompt-json',
        );
      } else {
        json.prompt = requireText(
          popFlag(args, '--prompt', undefined, { allowDashValue: true }),
          '--prompt',
        );
      }
      const labels = popRepeatedFlag(args, '--label');
      if (labels.length > 0) json.labels = labels;
      const tags = popRepeatedFlag(args, '--tag');
      if (tags.length > 0) json.tags = tags;
      const config = popFlag(args, '--config-json');
      if (config !== undefined) json.config = parseJsonFlag(config, '--config-json');
      const commitMessage = popFlag(args, '--commit-message', undefined, {
        allowDashValue: true,
      });
      if (commitMessage !== undefined) json.commitMessage = commitMessage;
      payload = build({ url: '/api/public/v2/prompts', method: 'POST', json });
      break;
    }
    default:
      die(`Unknown Langfuse operation: ${operation}`);
  }
  assertNoUnexpectedArgs(args);
  return payload;
}

function buildPlan(text) {
  const normalized = text.toLowerCase();
  let operation = 'list-traces';
  if (/\b(metric|analytics|aggregate|count|cost over time|daily)\b/.test(normalized)) {
    operation = 'metrics';
  } else if (/\b(score|eval|evaluat|rate|rating|grade)\b/.test(normalized) && /\b(add|create|write|record|submit|log)\b/.test(normalized)) {
    operation = 'create-score';
  } else if (/\b(comment|annotat|note)\b/.test(normalized) && /\b(add|create|write|leave)\b/.test(normalized)) {
    operation = 'create-comment';
  } else if (/\b(prompt)\b/.test(normalized) && /\b(create|new version|publish|push|update)\b/.test(normalized)) {
    operation = 'create-prompt';
  } else if (/\b(dataset item|test case|example)\b/.test(normalized) && /\b(add|create|new)\b/.test(normalized)) {
    operation = 'create-dataset-item';
  } else if (/\b(dataset)\b/.test(normalized) && /\b(create|new)\b/.test(normalized)) {
    operation = 'create-dataset';
  } else if (/\b(prompt)\b/.test(normalized)) {
    operation = 'list-prompts';
  } else if (/\b(dataset run|experiment run)\b/.test(normalized)) {
    operation = 'list-dataset-runs';
  } else if (/\b(dataset)\b/.test(normalized)) {
    operation = 'list-datasets';
  } else if (/\b(score|eval|rating)\b/.test(normalized)) {
    operation = 'list-scores';
  } else if (/\b(session|conversation)\b/.test(normalized)) {
    operation = 'list-sessions';
  } else if (/\b(observation|span|generation|llm call)\b/.test(normalized)) {
    operation = 'list-observations';
  } else if (/\b(model|pricing)\b/.test(normalized)) {
    operation = 'list-models';
  } else if (/\b(health|status|ping|connectivity)\b/.test(normalized)) {
    operation = 'health';
  }
  const tier = OPERATION_TIERS[operation];
  return {
    command: 'plan',
    operation,
    stakesTier: tier,
    requiresEscalation: tier !== 'green',
    requiredGrant: tier === 'green' ? null : `approve-langfuse-${operation}`,
    secretPolicy: {
      basicAuthSecret: BASIC_AUTH_SECRET,
      hostEnv: HOST_ENV,
      modelSeesSecret: false,
    },
    costMeasurement: COST_MEASUREMENT,
  };
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
    die('--gateway-url must be an absolute http or https URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    die('--gateway-url must use http or https.');
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
    die(
      `Cannot reach HybridClaw gateway at ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      1,
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let envelope;
  try {
    envelope = text ? JSON.parse(text) : {};
  } catch {
    die(`Gateway returned non-JSON response: ${text.slice(0, 500)}`, 1);
  }
  if (!response.ok) {
    die(
      `Gateway request failed with HTTP ${response.status}: ${text.slice(0, 500)}`,
      1,
    );
  }
  return envelope;
}

async function commandRun(args) {
  const gatewayUrl = resolveGatewayUrl(popFlag(args, '--gateway-url'));
  const gatewayToken = resolveGatewayToken(popFlag(args, '--gateway-token'));
  const requestPayload = commandHttpRequest(args);
  const response = await gatewayRequest(requestPayload.httpRequest, {
    gatewayUrl,
    gatewayToken,
  });
  return {
    command: 'run',
    operation: requestPayload.operation,
    stakesTier: requestPayload.stakesTier,
    response,
    costMeasurement: COST_MEASUREMENT,
    liveExecution: requestPayload.liveExecution,
  };
}

function commandEvalScenarios() {
  const scenarios = JSON.parse(require('node:fs').readFileSync(EVAL_SCENARIOS_PATH, 'utf-8'));
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
    costMeasurement: COST_MEASUREMENT,
  };
}

function printOutput(payload, format) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (format === 'text') {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  die('--format must be json or text.');
}

function showHelp() {
  process.stdout.write(`Langfuse skill helper

Usage:
  node skills/langfuse/langfuse.cjs [--format json] plan <request>
  node skills/langfuse/langfuse.cjs [--format json] run <operation> [flags]
  node skills/langfuse/langfuse.cjs [--format json] http-request <operation> [flags]
  node skills/langfuse/langfuse.cjs [--format json] eval-scenarios

Live execution:
  run sends the helper-built request through the HybridClaw gateway at /api/http/request.
  It uses HYBRIDCLAW_GATEWAY_URL or GATEWAY_BASE_URL, default ${DEFAULT_GATEWAY_URL}.
  It uses HYBRIDCLAW_GATEWAY_TOKEN, GATEWAY_API_TOKEN, or WEB_API_TOKEN if set.
  Use http-request only for dry-run payload inspection or runtimes without helper gateway access.

Auth and host (gateway-resolved, never seen by the model):
  Authorization: Basic <secret:${BASIC_AUTH_SECRET}>   (base64 of public-key:secret-key)
  Base URL defaults to ${HOST_PLACEHOLDER}; override with --host https://cloud.langfuse.com
  --basic-auth-secret NAME   Runtime secret with base64 public:secret (default ${BASIC_AUTH_SECRET})

Pagination (list operations):
  --limit n   page size, max 100 (Langfuse cap)
  --page n    page number (legacy endpoints) | --cursor c  cursor (modern endpoints)

Read operations (green):
  health
  get-project
  list-traces [--user-id u] [--name n] [--session-id s] [--from-timestamp iso] [--to-timestamp iso] [--tag t]... [--environment e]... [--page p] [--limit l]
  get-trace --trace-id id
  list-observations [--name n] [--type GENERATION|SPAN|EVENT] [--trace-id id] [--user-id u] [--from-start-time iso] [--page p] [--limit l]
  get-observation --observation-id id
  list-sessions [--from-timestamp iso] [--to-timestamp iso] [--environment e]... [--page p] [--limit l]
  get-session --session-id id
  list-scores [--name n] [--user-id u] [--source API|ANNOTATION|EVAL] [--data-type NUMERIC|CATEGORICAL|BOOLEAN] [--config-id id] [--page p] [--limit l]
  get-score --score-id id
  list-score-configs [--page p] [--limit l]
  get-score-config --config-id id
  list-prompts [--name n] [--label l] [--tag t] [--page p] [--limit l]
  get-prompt --prompt-name name [--version n | --label l]
  list-datasets [--page p] [--limit l]
  get-dataset --dataset-name name
  list-dataset-items [--dataset-name name] [--source-trace-id id] [--page p] [--limit l]
  get-dataset-item --item-id id
  list-dataset-runs --dataset-name name [--page p] [--limit l]
  get-dataset-run --dataset-name name --run-name name
  list-models [--page p] [--limit l]
  get-model --model-id id
  list-comments [--object-type TRACE|OBSERVATION|SESSION|PROMPT] [--object-id id] [--page p] [--limit l]
  get-comment --comment-id id
  metrics --query '<json metrics query>'

Write operations require --operator-grant (amber):
  create-score (--trace-id id | --observation-id id | --session-id id | --dataset-run-id id) --name n --value v [--data-type NUMERIC|CATEGORICAL|BOOLEAN] [--comment text] [--config-id id] [--environment e]
  create-comment --object-type TRACE|OBSERVATION|SESSION|PROMPT --object-id id --content text [--author-user-id u]
  create-dataset --name n [--description text] [--metadata-json '{...}']
  create-dataset-item --dataset-name n [--input-json '{...}'] [--expected-output-json '{...}'] [--metadata-json '{...}'] [--source-trace-id id] [--status ACTIVE|ARCHIVED]
  create-prompt --name n [--type text|chat] (--prompt text | --prompt-json '[...]') [--label l]... [--tag t]... [--config-json '{...}'] [--commit-message text]

Out of scope (use the Langfuse UI or admin API directly):
  deletions of any kind, and project / API-key / membership / organization / SCIM administration.
`);
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
    payload = buildPlan(args.join(' '));
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
