#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SKILL_NAME = 'fax-send';
const SINCH_BASE_URL = 'https://fax.api.sinch.com/v3';
const SINCH_BASIC_SECRET = 'SINCH_FAX_BASIC_AUTH';
const SINCH_OAUTH_SECRET = 'SINCH_FAX_OAUTH_TOKEN';
const SINCH_PROJECT_ID_SECRET = 'SINCH_FAX_PROJECT_ID';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');

const COST_MEASUREMENT = {
  system: 'UsageTotals',
  subLimitKey: 'fax-pages',
  unit: 'fax-page',
};

const LIVE_EXECUTION = {
  mode: 'live-fax-api',
  requiresConfiguredSecrets: [SINCH_PROJECT_ID_SECRET],
  requiresOneOfConfiguredSecrets: [SINCH_BASIC_SECRET, SINCH_OAUTH_SECRET],
  dryRunSafe:
    'For prompt/user testing, build the http-request payload and stop; do not call http_request unless the operator approved the send.',
  approvalPolicy:
    'fax.send requires explicit operator approval because it sends an external document and can incur per-page cost.',
  callPolicy:
    'Use this helper as the API wrapper. Pass only the emitted httpRequest object to http_request for live provider calls.',
  secretRefPolicy:
    'Do not inspect, print, or ask for fax provider secrets. The helper emits secret-backed Authorization metadata for gateway injection.',
  requestShape:
    'Do not handcraft provider fax API calls. The helper owns URL, method, JSON body, provider metadata, audit intent, and secret references.',
  unauthorizedPolicy:
    'If a live provider call returns 401 or 403, stop after the first failure and ask the operator to verify the stored credential.',
};

const PROVIDER_REFERENCE = [
  {
    id: 'sinch-eu',
    provider: 'sinch',
    residency: 'eu',
    implemented: true,
    sendOperation: 'fax.send',
    statusOperation: 'fax.status',
    notes:
      'Use a Sinch project/service configured for EU data residency and a fax-capable sender number.',
  },
  {
    id: 'phaxio',
    provider: 'phaxio',
    residency: 'provider-account-region',
    implemented: false,
    notes: 'Future adapter; Phaxio is listed for migration planning only.',
  },
  {
    id: 'telekom-cloud-fax',
    provider: 'telekom-cloud-fax',
    residency: 'de',
    implemented: false,
    notes: 'Future German operator adapter.',
  },
  {
    id: 'vodafone-mail2fax',
    provider: 'vodafone-mail2fax',
    residency: 'de',
    implemented: false,
    notes: 'Future German operator mail-to-fax adapter.',
  },
];

function usage() {
  return `
Fax Send skill helper

Build guarded fax-send requests and classify delivery states.

Usage:
  node skills/fax-send/fax_send.cjs [--format json] plan "Fax the signed PDF to +49 89 1234567"
  node skills/fax-send/fax_send.cjs [--format json] http-request send --content-url https://example.com/file.pdf --to +49891234567 --operator-grant
  node skills/fax-send/fax_send.cjs [--format json] http-request send --text "Hallo Welt" --to +49891234567 --operator-grant
  node skills/fax-send/fax_send.cjs [--format json] http-request status --fax-id <fax-id>
  node skills/fax-send/fax_send.cjs [--format json] classify-status --fax-id <fax-id> --status COMPLETED
  node skills/fax-send/fax_send.cjs [--format json] providers
  node skills/fax-send/fax_send.cjs [--format json] eval-scenarios

Global options:
  --format json|pretty       Output JSON or pretty-printed JSON. Default: pretty.
  --provider sinch           Provider adapter. Default: sinch.
  --auth basic|bearer        Sinch auth mode. Default: basic.
  --timeout-ms <ms>          Gateway request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --max-response-bytes <n>   Gateway response cap. Default: ${DEFAULT_MAX_RESPONSE_BYTES}

Send options:
  --content-url <url>        Public HTTP(S) URL of a supported file or web page to fax.
  --pdf-url <url>            Alias for --content-url.
  --text <text>              Plain text to send as a direct .txt file upload.
  --filename <name>          File name for --text uploads. Default: message.txt.
  --to <number>              Recipient fax number in E.164 format.
  --from <number>            Sender fax number in E.164 format.
  --project-id <id>          Sinch project id. Defaults to SINCH_FAX_PROJECT_ID.
  --service-id <id>          Optional explicit Sinch fax service id. Uses the default Sinch Fax service when omitted.
  --page-count <n>           Known PDF page count for page-based usage tracking.
  --cost-per-page-eur <n>    Optional operator cost estimate.
  --header-text <text>       Fax header text, max 50 chars.
  --no-header-page-numbers   Disable page numbers in the fax header.
  --header-time-zone <tz>    TZ database name for header timestamps.
  --callback-url <url>       Provider completion callback URL.
  --callback-json            Request JSON callback payloads.
  --max-retries <n>          Provider retry count, 0..5.
  --retry-delay-seconds <n>  Provider retry delay, 30..300.
  --resolution FINE|SUPERFINE
  --label <key=value>        Provider label. Repeatable.
  --operator-grant           Required for fax.send.

Status/classify options:
  --fax-id <id>
  --status QUEUED|IN_PROGRESS|COMPLETED|FAILURE
  --error-type <type>
  --error-code <code>
  --error-message <message>
  --pages-sent <n>
`.trim();
}

function die(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const opts = {
    auth: 'basic',
    format: 'pretty',
    provider: 'sinch',
    labels: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    headerPageNumbers: true,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
        die(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--format':
        opts.format = readValue();
        break;
      case '--provider':
        opts.provider = readValue();
        break;
      case '--auth':
        opts.auth = readValue();
        break;
      case '--timeout-ms':
        opts.timeoutMs = parseInteger(readValue(), '--timeout-ms', 1, 600_000);
        break;
      case '--max-response-bytes':
        opts.maxResponseBytes = parseInteger(
          readValue(),
          '--max-response-bytes',
          1,
          20_000_000,
        );
        break;
      case '--pdf-url':
      case '--content-url':
        opts.contentUrl = readValue();
        break;
      case '--text':
        opts.text = readValue();
        break;
      case '--filename':
        opts.filename = readValue();
        break;
      case '--to':
        opts.to = readValue();
        break;
      case '--from':
        opts.from = readValue();
        break;
      case '--project-id':
        opts.projectId = readValue();
        break;
      case '--service-id':
        opts.serviceId = readValue();
        break;
      case '--page-count':
        opts.pageCount = parseInteger(readValue(), '--page-count', 1, 10_000);
        break;
      case '--cost-per-page-eur':
        opts.costPerPageEur = parseMoney(readValue(), '--cost-per-page-eur');
        break;
      case '--header-text':
        opts.headerText = readValue();
        break;
      case '--no-header-page-numbers':
        opts.headerPageNumbers = false;
        break;
      case '--header-time-zone':
        opts.headerTimeZone = readValue();
        break;
      case '--callback-url':
        opts.callbackUrl = readValue();
        break;
      case '--callback-json':
        opts.callbackJson = true;
        break;
      case '--max-retries':
        opts.maxRetries = parseInteger(readValue(), '--max-retries', 0, 5);
        break;
      case '--retry-delay-seconds':
        opts.retryDelaySeconds = parseInteger(
          readValue(),
          '--retry-delay-seconds',
          30,
          300,
        );
        break;
      case '--resolution':
        opts.resolution = readValue();
        break;
      case '--label':
        opts.labels.push(readValue());
        break;
      case '--operator-grant':
        opts.operatorGrant = true;
        break;
      case '--fax-id':
        opts.faxId = readValue();
        break;
      case '--status':
        opts.status = readValue();
        break;
      case '--error-type':
        opts.errorType = readValue();
        break;
      case '--error-code':
        opts.errorCode = parseInteger(readValue(), '--error-code', 0, 999_999);
        break;
      case '--error-message':
        opts.errorMessage = readValue();
        break;
      case '--pages-sent':
        opts.pagesSent = parseInteger(readValue(), '--pages-sent', 0, 10_000);
        break;
      default:
        die(`Unknown option: ${arg}`);
    }
  }

  return { opts, positional };
}

function parseInteger(value, label, min, max) {
  if (!/^-?\d+$/u.test(String(value))) die(`${label} must be an integer.`);
  const parsed = Number.parseInt(String(value), 10);
  if (parsed < min || parsed > max) {
    die(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseMoney(value, label) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    die(`${label} must be a non-negative number.`);
  }
  return parsed;
}

function normalizeProvider(value) {
  const normalized = String(value || 'sinch').trim().toLowerCase();
  if (normalized !== 'sinch' && normalized !== 'sinch-eu') {
    die('--provider must be sinch or sinch-eu.');
  }
  return 'sinch';
}

function normalizeAuth(value) {
  const normalized = String(value || 'basic').trim().toLowerCase();
  if (normalized !== 'basic' && normalized !== 'bearer') {
    die('--auth must be basic or bearer.');
  }
  return normalized;
}

function requireNonEmpty(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function secretPlaceholder(secretName) {
  return `<secret:${secretName}>`;
}

function sinchProjectPathSegment(opts) {
  if (!opts.projectId) return secretPlaceholder(SINCH_PROJECT_ID_SECRET);
  return encodeURIComponent(requireNonEmpty(opts.projectId, '--project-id'));
}

function sinchServiceId(opts) {
  const explicit = String(opts.serviceId || '').trim();
  if (explicit) return explicit;
  return undefined;
}

function normalizePhoneNumber(value, label) {
  const compact = requireNonEmpty(value, label).replace(/[()\s.-]/gu, '');
  if (!/^\+[1-9]\d{6,14}$/u.test(compact)) {
    die(`${label} must be an E.164 phone number, for example +49891234567.`);
  }
  return compact;
}

function normalizeContentUrl(value) {
  const raw = requireNonEmpty(value, '--content-url');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    die('--content-url must be an absolute HTTP(S) URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    die('--content-url must use http or https.');
  }
  if (parsed.username || parsed.password) {
    die('--content-url must not include embedded credentials.');
  }
  return parsed.toString();
}

function normalizeTextUpload(value) {
  const text = requireNonEmpty(value, '--text');
  if (Buffer.byteLength(text, 'utf8') > 500_000) {
    die('--text must be 500000 bytes or fewer.');
  }
  return text;
}

function normalizeUploadFilename(value) {
  const filename = String(value || 'message.txt').trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/u.test(filename)) {
    die('--filename must use only letters, digits, dots, underscores, or hyphens.');
  }
  return filename;
}

function normalizeOptionalUrl(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    die(`${label} must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:') die(`${label} must use https.`);
  return parsed.toString();
}

function parseLabels(values) {
  const labels = {};
  for (const value of values) {
    const separator = String(value).indexOf('=');
    if (separator <= 0) die('--label must use key=value format.');
    const key = String(value).slice(0, separator).trim();
    const labelValue = String(value).slice(separator + 1).trim();
    if (!/^[a-z][a-z0-9._-]{0,62}$/iu.test(key)) {
      die(`Invalid label key: ${key}`);
    }
    labels[key] = labelValue;
  }
  return labels;
}

function appendMultipartField(parts, boundary, name, value) {
  if (value === undefined || value === null) return;
  parts.push(
    `--${boundary}`,
    `Content-Disposition: form-data; name="${name}"`,
    '',
    String(value),
  );
}

function buildTextMultipartBody(params) {
  const boundary = '----hybridclaw-fax-text-boundary';
  const text = normalizeTextUpload(params.text);
  if (text.includes(boundary)) {
    die('--text must not include the generated multipart boundary.');
  }
  const parts = [];
  appendMultipartField(parts, boundary, 'to', params.to);
  appendMultipartField(parts, boundary, 'from', params.from);
  appendMultipartField(parts, boundary, 'headerPageNumbers', params.headerPageNumbers);
  appendMultipartField(parts, boundary, 'serviceId', params.serviceId);
  appendMultipartField(parts, boundary, 'headerText', params.headerText);
  appendMultipartField(parts, boundary, 'headerTimeZone', params.headerTimeZone);
  appendMultipartField(parts, boundary, 'callbackUrl', params.callbackUrl);
  appendMultipartField(parts, boundary, 'callbackUrlContentType', params.callbackUrlContentType);
  appendMultipartField(parts, boundary, 'maxRetries', params.maxRetries);
  appendMultipartField(parts, boundary, 'retryDelaySeconds', params.retryDelaySeconds);
  appendMultipartField(parts, boundary, 'resolution', params.resolution);
  for (const [key, value] of Object.entries(params.labels)) {
    appendMultipartField(parts, boundary, `labels[${key}]`, value);
  }
  parts.push(
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${params.filename}"`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    `--${boundary}--`,
    '',
  );
  return {
    boundary,
    bodyBase64: Buffer.from(parts.join('\r\n'), 'utf8').toString('base64'),
  };
}

function buildCostMeasurement(opts) {
  return {
    ...COST_MEASUREMENT,
    ...(opts.pageCount ? { pageCount: opts.pageCount } : {}),
    ...(opts.costPerPageEur !== undefined
      ? { costPerPageEur: opts.costPerPageEur }
      : {}),
  };
}

function buildAuditIntent(eventType, opts, extra = {}) {
  return {
    eventType,
    payload: {
      provider: 'sinch',
      faxId: opts.faxId || null,
      providerMessageId: opts.faxId || null,
      to: opts.to ? normalizePhoneNumber(opts.to, '--to') : undefined,
      from: opts.from ? normalizePhoneNumber(opts.from, '--from') : undefined,
      pageCount: opts.pageCount || undefined,
      ...extra,
    },
  };
}

function buildSendRequest(opts) {
  normalizeProvider(opts.provider);
  const auth = normalizeAuth(opts.auth);
  if (!opts.operatorGrant) {
    die('fax.send requires --operator-grant after explicit operator approval.');
  }
  if (opts.contentUrl && opts.text) {
    die('Use either --content-url/--pdf-url or --text, not both.');
  }
  const projectId = sinchProjectPathSegment(opts);
  const payload = {
    to: normalizePhoneNumber(opts.to, '--to'),
    from: normalizePhoneNumber(opts.from, '--from'),
    headerPageNumbers: opts.headerPageNumbers,
  };
  const serviceId = sinchServiceId(opts);
  if (serviceId) payload.serviceId = serviceId;
  if (opts.headerText !== undefined) {
    const headerText = String(opts.headerText).trim();
    if (headerText.length > 50) die('--header-text must be 50 characters or fewer.');
    payload.headerText = headerText;
  }
  if (opts.headerTimeZone) payload.headerTimeZone = requireNonEmpty(opts.headerTimeZone, '--header-time-zone');
  if (opts.callbackUrl) payload.callbackUrl = normalizeOptionalUrl(opts.callbackUrl, '--callback-url');
  if (opts.callbackJson) payload.callbackUrlContentType = 'application/json';
  if (opts.maxRetries !== undefined) payload.maxRetries = opts.maxRetries;
  if (opts.retryDelaySeconds !== undefined) {
    payload.retryDelaySeconds = opts.retryDelaySeconds;
  }
  if (opts.resolution !== undefined) {
    const resolution = String(opts.resolution).trim().toUpperCase();
    if (resolution !== 'FINE' && resolution !== 'SUPERFINE') {
      die('--resolution must be FINE or SUPERFINE.');
    }
    payload.resolution = resolution;
  }
  const labels = parseLabels(opts.labels);

  const httpRequest = {
    url: `${SINCH_BASE_URL}/projects/${projectId}/faxes`,
    method: 'POST',
    skillName: SKILL_NAME,
    stakesTier: 'amber',
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes,
    skillRequestContract: {
      skillName: SKILL_NAME,
      operation: 'fax.send',
      provider: 'sinch',
      documentKind: opts.text ? 'txt' : 'content-url',
      requiresOperatorGrant: true,
      costUnit: 'fax-page',
    },
  };
  if (opts.text) {
    const multipart = buildTextMultipartBody({
      ...payload,
      labels,
      text: opts.text,
      filename: normalizeUploadFilename(opts.filename),
    });
    httpRequest.headers = {
      'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
    };
    httpRequest.bodyBase64 = multipart.bodyBase64;
  } else {
    if (!opts.contentUrl) die('Either --content-url/--pdf-url or --text is required.');
    httpRequest.json = {
      ...payload,
      contentUrl: [normalizeContentUrl(opts.contentUrl)],
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    };
  }
  if (auth === 'basic') {
    httpRequest.secretHeaders = [
      {
        name: 'Authorization',
        secretName: SINCH_BASIC_SECRET,
        prefix: 'Basic',
      },
    ];
  } else {
    httpRequest.bearerSecretName = SINCH_OAUTH_SECRET;
  }

  return {
    command: 'http-request',
    operation: 'fax.send',
    provider: 'sinch',
    stakesTier: 'amber',
    httpRequest,
    costMeasurement: buildCostMeasurement(opts),
    auditEvents: [buildAuditIntent('fax.send.start', opts)],
    liveExecution: LIVE_EXECUTION,
  };
}

function buildStatusRequest(opts) {
  normalizeProvider(opts.provider);
  const auth = normalizeAuth(opts.auth);
  const projectId = sinchProjectPathSegment(opts);
  const faxId = encodeURIComponent(requireNonEmpty(opts.faxId, '--fax-id'));
  const httpRequest = {
    url: `${SINCH_BASE_URL}/projects/${projectId}/faxes/${faxId}`,
    method: 'GET',
    skillName: SKILL_NAME,
    stakesTier: 'green',
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes,
  };
  if (auth === 'basic') {
    httpRequest.secretHeaders = [
      {
        name: 'Authorization',
        secretName: SINCH_BASIC_SECRET,
        prefix: 'Basic',
      },
    ];
  } else {
    httpRequest.bearerSecretName = SINCH_OAUTH_SECRET;
  }
  return {
    command: 'http-request',
    operation: 'fax.status',
    provider: 'sinch',
    stakesTier: 'green',
    httpRequest,
    liveExecution: LIVE_EXECUTION,
  };
}

function classifyStatus(opts) {
  const faxId = requireNonEmpty(opts.faxId, '--fax-id');
  const status = requireNonEmpty(opts.status, '--status').toUpperCase();
  const normalized = { ...opts, faxId };
  if (status === 'COMPLETED') {
    return {
      command: 'classify-status',
      provider: 'sinch',
      status,
      delivered: true,
      retryRecommended: false,
      auditEvents: [
        buildAuditIntent('fax.send.delivered', normalized, {
          status,
          pagesSent: opts.pagesSent,
        }),
      ],
    };
  }
  if (status === 'FAILURE') {
    const retryable = isRetryableFailure(opts);
    return {
      command: 'classify-status',
      provider: 'sinch',
      status,
      delivered: false,
      retryRecommended: retryable,
      auditEvents: [
        buildAuditIntent('fax.send.failed', normalized, {
          status,
          errorType: opts.errorType || null,
          errorCode: opts.errorCode ?? null,
          errorMessage: opts.errorMessage || null,
          retryable,
        }),
      ],
    };
  }
  if (status === 'QUEUED' || status === 'IN_PROGRESS') {
    return {
      command: 'classify-status',
      provider: 'sinch',
      status,
      delivered: false,
      retryRecommended: false,
      auditEvents: [],
    };
  }
  die('--status must be QUEUED, IN_PROGRESS, COMPLETED, or FAILURE.');
}

function isRetryableFailure(opts) {
  const haystack = `${opts.errorType || ''} ${opts.errorMessage || ''}`.toLowerCase();
  return (
    haystack.includes('busy') ||
    haystack.includes('call') ||
    haystack.includes('line') ||
    haystack.includes('timeout')
  );
}

function buildPlan(prompt) {
  const text = requireNonEmpty(prompt, 'plan prompt');
  const germanNumber = text.match(/\+49[\d\s().-]{5,}/u)?.[0] || null;
  return {
    command: 'plan',
    operation: 'fax.send',
    stakesTier: 'amber',
    provider: 'sinch',
    detectedRecipientNumber: germanNumber
      ? normalizePhoneNumber(germanNumber, 'detected recipient number')
      : null,
    requiredInputs: [
      'content URL or direct supported file',
      'recipient fax number in E.164 format',
      'sender fax number in E.164 format',
      'stored Sinch project id and credential',
      'operator approval for fax.send',
    ],
    costMeasurement: COST_MEASUREMENT,
    auditEvents: ['fax.send.start', 'fax.send.delivered', 'fax.send.failed'],
    liveExecution: LIVE_EXECUTION,
  };
}

async function sendFax(pdfUrl, recipientNumber, options = {}) {
  const payload = buildSendRequest({
    ...options,
    contentUrl: pdfUrl,
    to: recipientNumber,
    operatorGrant: options.operatorGrant === true,
  });
  if (typeof options.dispatch !== 'function') {
    return payload;
  }
  const response = await options.dispatch(payload.httpRequest);
  const faxId = extractFaxId(response);
  if (!faxId) die('Provider response did not include a fax id.');
  return faxId;
}

function extractFaxId(response) {
  if (!response) return null;
  if (typeof response.id === 'string') return response.id;
  if (typeof response.faxId === 'string') return response.faxId;
  if (response.body) {
    if (typeof response.body === 'string') {
      try {
        return extractFaxId(JSON.parse(response.body));
      } catch {
        return null;
      }
    }
    return extractFaxId(response.body);
  }
  if (response.data) return extractFaxId(response.data);
  return null;
}

function readEvalScenarios() {
  return JSON.parse(fs.readFileSync(EVAL_SCENARIOS_PATH, 'utf8'));
}

function writeResult(result, format) {
  const indentation = format === 'json' ? 0 : 2;
  process.stdout.write(`${JSON.stringify(result, null, indentation)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const { opts, positional } = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!['json', 'pretty'].includes(opts.format)) {
    die('--format must be json or pretty.');
  }

  const mode = positional[0];
  let result;
  if (mode === 'plan') {
    result = buildPlan(positional.slice(1).join(' '));
  } else if (mode === 'http-request') {
    const operation = positional[1];
    if (operation === 'send') result = buildSendRequest(opts);
    else if (operation === 'status') result = buildStatusRequest(opts);
    else die('http-request operation must be send or status.');
  } else if (mode === 'classify-status') {
    result = classifyStatus(opts);
  } else if (mode === 'providers') {
    result = { command: 'providers', providers: PROVIDER_REFERENCE };
  } else if (mode === 'eval-scenarios') {
    result = readEvalScenarios();
  } else {
    die('Expected mode: plan, http-request, classify-status, or eval-scenarios.');
  }
  writeResult(result, opts.format);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildPlan,
  buildSendRequest,
  buildStatusRequest,
  classifyStatus,
  extractFaxId,
  providerReference: PROVIDER_REFERENCE,
  sendFax,
};
