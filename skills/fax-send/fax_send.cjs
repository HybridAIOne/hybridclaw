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
const PDF_PAGE_WIDTH = 595.28;
const PDF_PAGE_HEIGHT = 841.89;
const PDF_MARGIN = 56;
const PDF_FONT_SIZE = 18;
const PDF_LINE_HEIGHT = 24;

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
    'Use this helper as the API wrapper. Pass only the emitted httpRequest object to http_request for live provider calls. After http_request returns, stop tool use for that send attempt and summarize the provider result once.',
  secretRefPolicy:
    'Do not inspect, print, or ask for fax provider secrets. The helper emits secret-backed Authorization metadata for gateway injection.',
  requestShape:
    'Do not handcraft provider fax API calls. The helper owns URL, method, JSON or multipart body, provider metadata, audit intent, and secret references. For generated PDFs, pass the local PDF path with --file. Do not write one-off multipart scripts, inspect helper source, search the web, or retry with a different payload shape unless the operator explicitly asks for debugging in a new turn.',
  unauthorizedPolicy:
    'If a live provider call returns 401 or 403, stop after the first failure and ask the operator to verify the stored credential.',
  terminalProviderResponsePolicy:
    'A Sinch response, including 4xx or 5xx, is the result of the send attempt. Report the status and response details in one summary; do not duplicate the status sentence in markdown and plain text, ask to retry, or continue with web_fetch, web_search, local PDF creation, source inspection, or a second provider request.',
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
  --file <path>              Local PDF file to upload directly.
  --pdf-file <path>          Alias for --file.
  --text <text>              Plain text to render into a generated PDF upload.
  --filename <name>          PDF file name for --text uploads. Default: message.pdf.
  --to <number>              Recipient fax number in E.164 format.
  --from <number>            Optional sender fax number in E.164 format. Omit to use the Sinch service default.
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
      case '--file':
      case '--pdf-file':
        opts.filePath = readValue();
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
  const normalized = String(value || 'sinch')
    .trim()
    .toLowerCase();
  if (normalized !== 'sinch' && normalized !== 'sinch-eu') {
    die('--provider must be sinch or sinch-eu.');
  }
  return 'sinch';
}

function normalizeAuth(value) {
  const normalized = String(value || 'basic')
    .trim()
    .toLowerCase();
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

function normalizePdfFilePath(value) {
  const filePath = requireNonEmpty(value, '--file');
  if (!filePath.toLowerCase().endsWith('.pdf')) {
    die('--file must point to a .pdf file.');
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0) die('--file must not be empty.');
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-', 'utf8'))) {
    die('--file must be a PDF file.');
  }
  return {
    filename: normalizePdfUploadFilename(path.basename(filePath)),
    bytes,
  };
}

function normalizePdfUploadFilename(value) {
  const filename = String(value || 'message.pdf').trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/u.test(filename)) {
    die(
      '--filename must use only letters, digits, dots, underscores, or hyphens.',
    );
  }
  return filename.toLowerCase().endsWith('.pdf')
    ? filename
    : `${filename.replace(/\.[^.]*$/u, '')}.pdf`;
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
    const labelValue = String(value)
      .slice(separator + 1)
      .trim();
    if (!/^[a-z][a-z0-9._-]{0,62}$/iu.test(key)) {
      die(`Invalid label key: ${key}`);
    }
    labels[key] = labelValue;
  }
  return labels;
}

function appendMultipartFieldBuffer(buffers, boundary, name, value) {
  if (value === undefined || value === null) return;
  buffers.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
      'utf8',
    ),
  );
}

function escapePdfText(value) {
  return [...String(value)]
    .map((character) => {
      const codePoint = character.codePointAt(0) || 0;
      return codePoint >= 32 && codePoint <= 126 ? character : '?';
    })
    .join('')
    .replace(/\\/gu, '\\\\')
    .replace(/\(/gu, '\\(')
    .replace(/\)/gu, '\\)');
}

function wrapPdfTextLine(line, maxCharacters) {
  if (!line.trim()) return [''];
  const words = line.trim().split(/\s+/u);
  const wrapped = [];
  let current = '';

  for (const word of words) {
    if (word.length > maxCharacters) {
      if (current) {
        wrapped.push(current);
        current = '';
      }
      for (let index = 0; index < word.length; index += maxCharacters) {
        wrapped.push(word.slice(index, index + maxCharacters));
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters) {
      current = candidate;
      continue;
    }
    if (current) wrapped.push(current);
    current = word;
  }

  if (current) wrapped.push(current);
  return wrapped;
}

function buildPdfTextPages(text) {
  const normalized = normalizeTextUpload(text)
    .replace(/\\n/gu, '\n')
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n');
  const maxCharacters = Math.max(
    20,
    Math.floor((PDF_PAGE_WIDTH - PDF_MARGIN * 2) / (PDF_FONT_SIZE * 0.55)),
  );
  const maxLines = Math.max(
    1,
    Math.floor((PDF_PAGE_HEIGHT - PDF_MARGIN * 2) / PDF_LINE_HEIGHT),
  );
  const lines = normalized
    .split('\n')
    .flatMap((line) => wrapPdfTextLine(line, maxCharacters));
  const pages = [];
  for (let index = 0; index < lines.length; index += maxLines) {
    pages.push(lines.slice(index, index + maxLines));
  }
  return pages.length > 0 ? pages : [['']];
}

function pdfObject(id, body) {
  return `${id} 0 obj\n${body}\nendobj\n`;
}

function buildTextPdfBuffer(text) {
  const pages = buildPdfTextPages(text);
  const pageObjectStart = 4;
  const contentObjectStart = pageObjectStart + pages.length;
  const pageRefs = pages
    .map((_, index) => `${pageObjectStart + index} 0 R`)
    .join(' ');
  const objects = [
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(
      2,
      `<< /Type /Pages /Kids [ ${pageRefs} ] /Count ${pages.length} >>`,
    ),
    pdfObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];

  pages.forEach((_, index) => {
    const contentRef = contentObjectStart + index;
    objects.push(
      pdfObject(
        pageObjectStart + index,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`,
      ),
    );
  });

  pages.forEach((lines, index) => {
    const textCommands = lines
      .map((line, lineIndex) =>
        lineIndex === 0
          ? `(${escapePdfText(line)}) Tj`
          : `T* (${escapePdfText(line)}) Tj`,
      )
      .join('\n');
    const stream = [
      'BT',
      `/F1 ${PDF_FONT_SIZE} Tf`,
      `${PDF_LINE_HEIGHT} TL`,
      `1 0 0 1 ${PDF_MARGIN} ${PDF_PAGE_HEIGHT - PDF_MARGIN - PDF_FONT_SIZE} Tm`,
      textCommands,
      'ET',
    ].join('\n');
    objects.push(
      pdfObject(
        contentObjectStart + index,
        `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`,
      ),
    );
  });

  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}

function buildTextPdfMultipartBody(params) {
  const boundary = '----hybridclaw-fax-pdf-boundary';
  const text = normalizeTextUpload(params.text);
  if (text.includes(boundary)) {
    die('--text must not include the generated multipart boundary.');
  }
  const buffers = [];
  appendMultipartFieldBuffer(buffers, boundary, 'to', params.to);
  appendMultipartFieldBuffer(buffers, boundary, 'from', params.from);
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'headerPageNumbers',
    params.headerPageNumbers,
  );
  appendMultipartFieldBuffer(buffers, boundary, 'serviceId', params.serviceId);
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'headerText',
    params.headerText,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'headerTimeZone',
    params.headerTimeZone,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'callbackUrl',
    params.callbackUrl,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'callbackUrlContentType',
    params.callbackUrlContentType,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'maxRetries',
    params.maxRetries,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'retryDelaySeconds',
    params.retryDelaySeconds,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'resolution',
    params.resolution,
  );
  for (const [key, value] of Object.entries(params.labels)) {
    appendMultipartFieldBuffer(buffers, boundary, `labels[${key}]`, value);
  }
  buffers.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${params.filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
      'utf8',
    ),
    buildTextPdfBuffer(text),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );
  return {
    boundary,
    bodyBase64: Buffer.concat(buffers).toString('base64'),
  };
}

function buildPdfFileMultipartBody(params) {
  const boundary = '----hybridclaw-fax-pdf-boundary';
  const file = normalizePdfFilePath(params.filePath);
  const buffers = [];
  appendMultipartFieldBuffer(buffers, boundary, 'to', params.to);
  appendMultipartFieldBuffer(buffers, boundary, 'from', params.from);
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'headerPageNumbers',
    params.headerPageNumbers,
  );
  appendMultipartFieldBuffer(buffers, boundary, 'serviceId', params.serviceId);
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'headerText',
    params.headerText,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'headerTimeZone',
    params.headerTimeZone,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'callbackUrl',
    params.callbackUrl,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'callbackUrlContentType',
    params.callbackUrlContentType,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'maxRetries',
    params.maxRetries,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'retryDelaySeconds',
    params.retryDelaySeconds,
  );
  appendMultipartFieldBuffer(
    buffers,
    boundary,
    'resolution',
    params.resolution,
  );
  for (const [key, value] of Object.entries(params.labels)) {
    appendMultipartFieldBuffer(buffers, boundary, `labels[${key}]`, value);
  }
  buffers.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
      'utf8',
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );
  return {
    boundary,
    bodyBase64: Buffer.concat(buffers).toString('base64'),
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
  const payload = {
    provider: 'sinch',
    faxId: opts.faxId || null,
    providerMessageId: opts.faxId || null,
    pageCount: opts.pageCount || undefined,
    ...extra,
  };
  if (opts.to) payload.to = normalizePhoneNumber(opts.to, '--to');
  if (opts.from) payload.from = normalizePhoneNumber(opts.from, '--from');
  return {
    eventType,
    payload,
  };
}

function buildSendRequest(opts) {
  normalizeProvider(opts.provider);
  const auth = normalizeAuth(opts.auth);
  if (!opts.operatorGrant) {
    die('fax.send requires --operator-grant after explicit operator approval.');
  }
  const contentSources = [opts.contentUrl, opts.filePath, opts.text].filter(
    Boolean,
  );
  if (contentSources.length > 1) {
    die(
      'Use exactly one of --content-url/--pdf-url, --file/--pdf-file, or --text.',
    );
  }
  const projectId = sinchProjectPathSegment(opts);
  const payload = {
    to: normalizePhoneNumber(opts.to, '--to'),
    headerPageNumbers: opts.headerPageNumbers,
  };
  if (opts.from) payload.from = normalizePhoneNumber(opts.from, '--from');
  const serviceId = sinchServiceId(opts);
  if (serviceId) payload.serviceId = serviceId;
  if (opts.headerText !== undefined) {
    const headerText = String(opts.headerText).trim();
    if (headerText.length > 50)
      die('--header-text must be 50 characters or fewer.');
    payload.headerText = headerText;
  }
  if (opts.headerTimeZone)
    payload.headerTimeZone = requireNonEmpty(
      opts.headerTimeZone,
      '--header-time-zone',
    );
  if (opts.callbackUrl)
    payload.callbackUrl = normalizeOptionalUrl(
      opts.callbackUrl,
      '--callback-url',
    );
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
      documentKind: opts.text || opts.filePath ? 'pdf' : 'content-url',
      requiresOperatorGrant: true,
      costUnit: 'fax-page',
    },
  };
  if (opts.filePath) {
    const multipart = buildPdfFileMultipartBody({
      ...payload,
      labels,
      filePath: opts.filePath,
    });
    httpRequest.headers = {
      'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
    };
    httpRequest.bodyBase64 = multipart.bodyBase64;
  } else if (opts.text) {
    const multipart = buildTextPdfMultipartBody({
      ...payload,
      labels,
      text: opts.text,
      filename: normalizePdfUploadFilename(opts.filename),
    });
    httpRequest.headers = {
      'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
    };
    httpRequest.bodyBase64 = multipart.bodyBase64;
  } else {
    if (!opts.contentUrl)
      die(
        'One of --content-url/--pdf-url, --file/--pdf-file, or --text is required.',
      );
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
  const haystack =
    `${opts.errorType || ''} ${opts.errorMessage || ''}`.toLowerCase();
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
      'content URL, local PDF file, or direct supported text',
      'recipient fax number in E.164 format',
      'optional sender fax number in E.164 format, otherwise Sinch service default',
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
    die(
      'Expected mode: plan, http-request, classify-status, or eval-scenarios.',
    );
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
