#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const API_URL = 'https://my.fastbill.com/api/1.0/api.php';
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const DEFAULT_TIMEOUT_MS = 30000;
const GATEWAY_TIMEOUT_BUFFER_MS = 5000;
const DEFAULT_AUTH_SECRET_NAME = 'FASTBILL_BASIC_AUTH';
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');
const EINVOICE_FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'einvoice-readiness.json',
);

const READ_SERVICES = new Set([
  'article.get',
  'contact.get',
  'customer.get',
  'document.get',
  'estimate.get',
  'expense.get',
  'invoice.get',
  'item.get',
  'project.get',
  'recurring.get',
  'revenue.get',
  'template.get',
  'time.get',
  'webhook.get',
  'webhooks.get',
]);

const WRITE_SERVICES = new Set([
  'article.create',
  'article.update',
  'article.delete',
  'contact.create',
  'contact.update',
  'contact.delete',
  'customer.create',
  'customer.update',
  'customer.delete',
  'document.create',
  'estimate.create',
  'estimate.sendbyemail',
  'estimate.createinvoice',
  'estimate.delete',
  'expense.create',
  'invoice.create',
  'invoice.update',
  'invoice.delete',
  'invoice.complete',
  'invoice.cancel',
  'invoice.lock',
  'invoice.sendbyemail',
  'invoice.sendbypost',
  'invoice.setpaid',
  'project.create',
  'project.update',
  'project.delete',
  'recurring.create',
  'recurring.update',
  'recurring.delete',
  'revenue.create',
  'revenue.setpaid',
  'revenue.delete',
  'time.create',
  'time.update',
  'time.delete',
  'webhook.create',
  'webhook.delete',
  'webhooks.create',
  'webhooks.delete',
]);

const SUPPORTED_SERVICES = new Set([...READ_SERVICES, ...WRITE_SERVICES]);

class FastBillConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FastBillConfigError';
    this.code = 'FASTBILL_CONFIG_ERROR';
  }
}

class FastBillCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FastBillCredentialError';
    this.code = 'FASTBILL_CREDENTIAL_REJECTED';
    this.status = 401;
  }
}

class FastBillApiError extends Error {
  constructor(message, input = {}) {
    super(message);
    this.name = 'FastBillApiError';
    this.code = 'FASTBILL_API_ERROR';
    this.status = input.status || null;
    this.errors = input.errors || [];
  }
}

class FastBillOperatorGrantError extends Error {
  constructor(service) {
    super(
      `FastBill service ${service} mutates account data and requires --operator-grant.`,
    );
    this.name = 'FastBillOperatorGrantError';
    this.code = 'FASTBILL_OPERATOR_GRANT_REQUIRED';
    this.service = service;
  }
}

function isFastBillCredentialRejection(status, body) {
  return (
    Number(status) === 401 &&
    /Wrong API KEY|user credentials|API KEY|credentials/iu.test(
      String(body || ''),
    )
  );
}

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
      'call_count',
      'total_tool_calls',
    ],
  };
}

function resolveGatewayUrl() {
  return (
    (process.env.HYBRIDCLAW_GATEWAY_URL || '').trim() ||
    (process.env.GATEWAY_BASE_URL || '').trim() ||
    DEFAULT_GATEWAY_URL
  );
}

function resolveGatewayToken() {
  return (
    (process.env.HYBRIDCLAW_GATEWAY_TOKEN || '').trim() ||
    (process.env.GATEWAY_API_TOKEN || '').trim() ||
    (process.env.WEB_API_TOKEN || '').trim() ||
    ''
  );
}

function escapeXml(value) {
  return (
    String(value)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 disallows these characters.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

function toXmlNode(name, value) {
  if (!/^[A-Z0-9_]+$/u.test(name)) {
    throw new FastBillConfigError(`Invalid FastBill XML tag: ${name}`);
  }
  if (value === null || value === undefined) {
    return `<${name}/>`;
  }
  if (Array.isArray(value)) {
    const singular = name.endsWith('S') ? name.slice(0, -1) : 'ITEM';
    const children = value.map((entry) => toXmlNode(singular, entry)).join('');
    return name.endsWith('S') ? `<${name}>${children}</${name}>` : children;
  }
  if (typeof value === 'object') {
    const children = Object.entries(value)
      .filter(([, childValue]) => childValue !== undefined)
      .map(([childName, childValue]) => toXmlNode(childName, childValue))
      .join('');
    return `<${name}>${children}</${name}>`;
  }
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function buildFastBillXmlRequest(input) {
  const service = input.service;
  let xml = '<?xml version="1.0" encoding="utf-8"?><FBAPI>';
  xml += `<SERVICE>${escapeXml(service)}</SERVICE>`;
  if (input.limit !== undefined) xml += toXmlNode('LIMIT', String(input.limit));
  if (input.offset !== undefined)
    xml += toXmlNode('OFFSET', String(input.offset));
  if (input.filter !== undefined) xml += toXmlNode('FILTER', input.filter);
  if (input.data !== undefined) xml += toXmlNode('DATA', input.data);
  xml += '</FBAPI>';
  return xml;
}

function parseFastBillXmlResponse(xmlText) {
  let XMLParser;
  try {
    ({ XMLParser } = require('fast-xml-parser'));
  } catch {
    warnXmlFallback();
    const root = parseFastBillXmlFallback(xmlText);
    assertNoApiErrors(root);
    return root;
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xmlText);
  const root = parsed?.FBAPI ? parsed.FBAPI : parsed;
  assertNoApiErrors(root);
  return root;
}

function warnXmlFallback() {
  if (process.env.FASTBILL_XML_FALLBACK_WARNINGS === '0') return;
  process.stderr.write(
    'Warning: fast-xml-parser is unavailable; using a limited parser for well-formed FastBill XML only.\n',
  );
}

function parseFastBillXmlFallback(xmlText) {
  // Limited fallback for well-formed FastBill XML in local skill validation.
  const root = {};
  const stack = [{ name: '__ROOT__', value: root }];
  const tokens = String(xmlText || '').match(/<[^>]+>|[^<]+/gu) || [];
  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      const node = stack.pop();
      if (!node || stack.length === 0) {
        throw new FastBillConfigError('Invalid FastBill XML response.');
      }
      const value = normalizeFallbackNodeValue(node.value);
      const parent = stack[stack.length - 1].value;
      appendFallbackChild(parent, node.name, value);
      continue;
    }
    if (token.startsWith('<')) {
      const selfClosing = token.endsWith('/>');
      const name = token
        .replace(/^</u, '')
        .replace(/\/?>$/u, '')
        .trim()
        .split(/\s+/u)[0];
      if (!name) continue;
      if (selfClosing) {
        appendFallbackChild(stack[stack.length - 1].value, name, '');
      } else {
        stack.push({ name, value: { __TEXT__: '' } });
      }
      continue;
    }
    const text = unescapeXml(token.trim());
    if (text) {
      const current = stack[stack.length - 1].value;
      current.__TEXT__ = `${current.__TEXT__ || ''}${text}`;
    }
  }
  if (stack.length !== 1) {
    throw new FastBillConfigError('Invalid FastBill XML response.');
  }
  return root.FBAPI || root;
}

function normalizeFallbackNodeValue(value) {
  const entries = Object.entries(value).filter(([key]) => key !== '__TEXT__');
  if (entries.length === 0) return value.__TEXT__ || '';
  if (value.__TEXT__ && String(value.__TEXT__).trim()) {
    value.TEXT = value.__TEXT__;
  }
  delete value.__TEXT__;
  return value;
}

function appendFallbackChild(parent, name, value) {
  if (parent[name] === undefined) {
    parent[name] = value;
  } else if (Array.isArray(parent[name])) {
    parent[name].push(value);
  } else {
    parent[name] = [parent[name], value];
  }
}

function unescapeXml(value) {
  return String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function collectErrors(value) {
  return collectNodesByKey(value, 'ERROR').map(normalizeError).filter(Boolean);
}

function assertNoApiErrors(root) {
  const errors = collectErrors(root);
  if (errors.length > 0) {
    throw new FastBillApiError(
      `FastBill API returned ${errors.length} error(s).`,
      {
        errors,
      },
    );
  }
}

function normalizeError(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return { message: value };
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = entry;
    if (!out.message && typeof value.MESSAGE === 'string')
      out.message = value.MESSAGE;
    return out;
  }
  return { message: String(value) };
}

function collectNodesByKey(value, targetKey) {
  const matches = [];
  const scan = (node, key = '') => {
    if (key === targetKey) {
      if (Array.isArray(node)) matches.push(...node);
      else matches.push(node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) scan(entry, key);
      return;
    }
    for (const [childKey, childValue] of Object.entries(node)) {
      scan(childValue, childKey);
    }
  };
  scan(value);
  return matches;
}

function normalizeService(service) {
  const normalized = String(service || '')
    .trim()
    .toLowerCase();
  if (!SUPPORTED_SERVICES.has(normalized)) {
    throw new FastBillConfigError(`Unsupported FastBill service: ${service}`);
  }
  return normalized;
}

function assertOperatorGrant(service, hasGrant, dryRun) {
  if (WRITE_SERVICES.has(service) && !hasGrant && !dryRun) {
    throw new FastBillOperatorGrantError(service);
  }
}

function buildGatewayRequestPayload(input) {
  const payload = {
    url: API_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      Accept: 'application/xml',
    },
    body: input.body,
    timeoutMs: input.timeoutMs || DEFAULT_TIMEOUT_MS,
    secretHeaders: [
      {
        name: 'Authorization',
        secretName: input.authSecretName || DEFAULT_AUTH_SECRET_NAME,
        prefix: 'Basic',
      },
    ],
  };
  if (input.traceId) payload.headers['x-trace-id'] = input.traceId;
  return payload;
}

function buildFastBillHttpRequest(input) {
  const service = normalizeService(input.service);
  const mutatesAccount = WRITE_SERVICES.has(service);
  assertOperatorGrant(service, Boolean(input.operatorGrant), false);
  const xml = buildFastBillXmlRequest({
    service,
    filter: input.filter,
    data: input.data,
    limit: input.limit,
    offset: input.offset,
  });
  return {
    service,
    mutatesAccount,
    httpRequest: buildGatewayRequestPayload({
      body: xml,
      authSecretName: input.authSecretName,
      timeoutMs: input.timeoutMs,
      traceId: input.traceId,
    }),
    costMeasurement: usageTotalsMeasurement(),
  };
}

async function gatewayRequest(input) {
  const gatewayUrl = (input.gatewayUrl || resolveGatewayUrl()).replace(
    /\/+$/u,
    '',
  );
  const payload = buildGatewayRequestPayload(input);

  const headers = { 'Content-Type': 'application/json' };
  const token = input.gatewayToken || resolveGatewayToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    (input.timeoutMs || DEFAULT_TIMEOUT_MS) + GATEWAY_TIMEOUT_BUFFER_MS,
  );
  let response;
  try {
    response = await fetch(`${gatewayUrl}/api/http/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) {
    if (
      response.status === 401 &&
      /WEB_API_TOKEN|GATEWAY_API_TOKEN/u.test(text)
    ) {
      throw new FastBillConfigError(
        'Gateway proxy authentication failed before FastBill was contacted. Set HYBRIDCLAW_GATEWAY_TOKEN, GATEWAY_API_TOKEN, or WEB_API_TOKEN in the helper environment to a token accepted by the local gateway.',
      );
    }
    throw new FastBillApiError(
      `Gateway proxy returned ${response.status} for FastBill request: ${text}`,
      { status: response.status },
    );
  }
  let wrapper;
  try {
    wrapper = JSON.parse(text);
  } catch {
    return text;
  }
  if (wrapper && wrapper.ok === false) {
    const body = wrapper.body || wrapper.statusText || '';
    if (isFastBillCredentialRejection(wrapper.status, body)) {
      throw new FastBillCredentialError(
        'FastBill rejected the Basic auth credentials. The gateway and secret route worked, but FASTBILL_BASIC_AUTH decodes to an email/API-key pair FastBill does not accept.',
      );
    }
    throw new FastBillApiError(
      `FastBill returned HTTP ${wrapper.status || 'error'}: ${body}`,
      { status: wrapper.status || null },
    );
  }
  if (typeof wrapper.body === 'string') return wrapper.body;
  if (typeof wrapper.text === 'string') {
    process.stderr.write(
      'Warning: gateway response omitted body; using text fallback.\n',
    );
    return wrapper.text;
  }
  if (typeof wrapper.responseText === 'string') {
    process.stderr.write(
      'Warning: gateway response omitted body; using responseText fallback.\n',
    );
    return wrapper.responseText;
  }
  throw new FastBillApiError(
    'Gateway response did not include a FastBill XML response body.',
  );
}

async function callFastBillService(input) {
  const service = normalizeService(input.service);
  const mutatesAccount = WRITE_SERVICES.has(service);
  assertOperatorGrant(
    service,
    Boolean(input.operatorGrant),
    Boolean(input.dryRun),
  );
  const xml = buildFastBillXmlRequest({
    service,
    filter: input.filter,
    data: input.data,
    limit: input.limit,
    offset: input.offset,
  });
  if (input.dryRun) {
    return {
      dryRun: true,
      service,
      mutatesAccount,
      xml,
      costMeasurement: usageTotalsMeasurement(),
    };
  }
  const xmlResponse = await gatewayRequest({
    body: xml,
    authSecretName: input.authSecretName,
    gatewayUrl: input.gatewayUrl,
    gatewayToken: input.gatewayToken,
    timeoutMs: input.timeoutMs,
    traceId: input.traceId,
  });
  return {
    service,
    mutatesAccount,
    response: parseFastBillXmlResponse(xmlResponse),
    costMeasurement: usageTotalsMeasurement(),
  };
}

function ensureJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FastBillConfigError(`${label} must be a JSON object.`);
  }
  return value;
}

function parseJsonValue(raw, label) {
  if (!raw) return undefined;
  try {
    return ensureJsonObject(JSON.parse(raw), label);
  } catch (error) {
    if (error instanceof FastBillConfigError) throw error;
    throw new FastBillConfigError(
      `${label} is not valid JSON: ${error.message}`,
    );
  }
}

function parseJsonFile(filePath, label) {
  if (!filePath) return undefined;
  try {
    return parseJsonValue(fs.readFileSync(filePath, 'utf8'), label);
  } catch (error) {
    if (error instanceof FastBillConfigError) throw error;
    throw new FastBillConfigError(
      `Cannot read ${label} JSON file ${filePath}: ${error.message}`,
    );
  }
}

function parseTextFile(filePath, label) {
  if (!filePath) return undefined;
  try {
    return fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch (error) {
    throw new FastBillConfigError(
      `Cannot read ${label} text file ${filePath}: ${error.message}`,
    );
  }
}

function resolveTextInput(args, label) {
  const inlineValue = args[label];
  const fileValue = parseTextFile(args[`${label}-file`], label);
  if (inlineValue && fileValue) {
    throw new FastBillConfigError(
      `Use either --${label} or --${label}-file, not both.`,
    );
  }
  if (!inlineValue && !fileValue) {
    throw new FastBillConfigError(`--${label} or --${label}-file is required.`);
  }
  return inlineValue || fileValue;
}

function parseFastBillHttpResponse(raw) {
  let xmlText = raw;
  try {
    const wrapper = JSON.parse(raw);
    if (wrapper && typeof wrapper === 'object') {
      if (wrapper.ok === false) {
        const body = wrapper.body || wrapper.statusText || '';
        if (isFastBillCredentialRejection(wrapper.status, body)) {
          throw new FastBillCredentialError(
            'FastBill rejected the Basic auth credentials. The gateway and secret route worked, but FASTBILL_BASIC_AUTH decodes to an email/API-key pair FastBill does not accept.',
          );
        }
        throw new FastBillApiError(
          `FastBill returned HTTP ${wrapper.status || 'error'}: ${body}`,
          { status: wrapper.status || null },
        );
      }
      if (typeof wrapper.body === 'string') xmlText = wrapper.body;
      else if (typeof wrapper.text === 'string') xmlText = wrapper.text;
      else if (typeof wrapper.responseText === 'string')
        xmlText = wrapper.responseText;
    }
  } catch (error) {
    if (error instanceof FastBillApiError) throw error;
    if (error instanceof FastBillCredentialError) throw error;
  }
  return {
    response: parseFastBillXmlResponse(xmlText),
    costMeasurement: usageTotalsMeasurement(),
  };
}

function resolveJsonInput(args, label) {
  return (
    parseJsonValue(args[`${label}-json`], label) ||
    parseJsonFile(args[`${label}-file`], label)
  );
}

function findInvoices(response) {
  return collectNodesByKey(response, 'INVOICE').filter(
    (invoice) => invoice && typeof invoice === 'object',
  );
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(
    date.getUTCDate() - parseNonNegativeInt(days, '--older-than-days'),
  );
  return date.toISOString().slice(0, 10);
}

function filterInvoices(invoices, input) {
  let filtered = invoices;
  if (input.state) {
    const expected = String(input.state).toLowerCase();
    filtered = filtered.filter(
      (invoice) => String(invoice.STATE || '').toLowerCase() === expected,
    );
  }
  return filtered;
}

function parseNonNegativeInt(value, flag) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!/^\d+$/u.test(String(value))) {
    throw new FastBillConfigError(`${flag} must be a non-negative integer.`);
  }
  return Number(value);
}

function parseIsoDate(value, flag) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value))) {
    throw new FastBillConfigError(`${flag} must use YYYY-MM-DD format.`);
  }
  return value;
}

function planFastBillRequest(text) {
  const raw = String(text || '').trim();
  const normalized = raw.toLowerCase();
  let service = 'invoice.get';
  let mutatesAccount = false;
  let operatorGrantRequired = false;
  let command = 'list-invoices';

  if (
    /(create|new).*(invoice|rechnung)|\bdraft\b.*\bnew\b.*(invoice|rechnung)|\bprepare\b.*(invoice|rechnung)/u.test(
      normalized,
    )
  ) {
    service = 'invoice.create';
    command = 'create-invoice';
  } else if (
    /(xrechnung|zugferd|e-?invoice|electronic invoice)/u.test(normalized)
  ) {
    service = 'invoice.get';
    command = 'export-einvoice';
  } else if (
    /(delete|remove).*(invoice|rechnung)|test invoice.*(delete|remove)/u.test(
      normalized,
    )
  ) {
    service = 'invoice.delete';
    command = 'request invoice.delete';
  } else if (
    /(cancel|void|storno).*(invoice|rechnung)|invoice.*(cancel|void|storno)/u.test(
      normalized,
    )
  ) {
    service = 'invoice.cancel';
    command = 'request invoice.cancel';
  } else if (
    /(complete|finalize|finalise).*(invoice|rechnung)|draft invoice.*(complete|finalize|finalise)/u.test(
      normalized,
    )
  ) {
    service = 'invoice.complete';
    command = 'request invoice.complete';
  } else if (
    /(update|change|correct).*(invoice|rechnung)|draft invoice.*(update|change|correct)/u.test(
      normalized,
    )
  ) {
    service = 'invoice.update';
    command = 'request invoice.update';
  } else if (/(create|new|add).*(customer|client|kunde)/u.test(normalized)) {
    service = 'customer.create';
    command = 'request customer.create';
  } else if (/(mark|set).*(paid|bezahlt)/u.test(normalized)) {
    service = 'invoice.setpaid';
    command = 'mark-paid';
  } else if (
    /(reminder|mahnung|payment reminder|send.*email)/u.test(normalized)
  ) {
    service = 'invoice.sendbyemail';
    command = 'send-reminder';
  } else if (/(document inbox|documents|folder)/u.test(normalized)) {
    service = 'document.get';
    command = 'request document.get';
  } else if (/(article|articles|product|products)/u.test(normalized)) {
    service = 'article.get';
    command = 'request article.get';
  } else if (/(customer|client|kunde)/u.test(normalized)) {
    service = 'customer.get';
    command = 'request customer.get';
  }

  mutatesAccount = WRITE_SERVICES.has(service);
  operatorGrantRequired = mutatesAccount;
  return {
    input: raw,
    command,
    service,
    mutatesAccount,
    operatorGrantRequired,
    defaultAutonomy: mutatesAccount
      ? 'operator_grant_required'
      : 'read_allowed',
    costMeasurement: usageTotalsMeasurement(),
  };
}

function loadEvalScenarios() {
  return JSON.parse(fs.readFileSync(EVAL_SCENARIOS_PATH, 'utf8'));
}

function loadEInvoiceFixture() {
  return JSON.parse(fs.readFileSync(EINVOICE_FIXTURE_PATH, 'utf8'));
}

function evaluateScenarios() {
  const scenarios = loadEvalScenarios();
  const einvoiceFixture = loadEInvoiceFixture();
  const results = scenarios.map((scenario) => {
    const plan = planFastBillRequest(scenario.prompt);
    const pass =
      plan.service === scenario.expected.service &&
      plan.operatorGrantRequired === scenario.expected.operatorGrantRequired;
    return {
      id: scenario.id,
      category: scenario.category,
      pass,
      expected: scenario.expected,
      actual: {
        service: plan.service,
        operatorGrantRequired: plan.operatorGrantRequired,
      },
    };
  });
  const failed = results.filter((result) => !result.pass);
  return {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    fixtureCoverage: {
      einvoiceFormats: einvoiceFixture.formats,
      requiredBuyerChecks: einvoiceFixture.requiredBuyerChecks.length,
      hasXRechnung: einvoiceFixture.formats.includes('XRechnung'),
      hasZugferd: einvoiceFixture.formats.includes('ZUGFeRD'),
    },
    results,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (['dry-run', 'operator-grant', 'help'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new FastBillConfigError(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`FastBill skill helper

Usage:
  node skills/fastbill/fastbill.cjs http-request <service> [--filter-json JSON] [--data-json JSON] [--limit N] [--offset N] [--operator-grant]
  node skills/fastbill/fastbill.cjs parse-response --body-file PATH
  node skills/fastbill/fastbill.cjs request <service> [--filter-json JSON] [--data-json JSON] [--limit N] [--offset N] [--dry-run] [--operator-grant]
  node skills/fastbill/fastbill.cjs list-invoices [--state unpaid|overdue|paid|draft] [--older-than-days N] [--limit N] [--offset N] [--dry-run]
  node skills/fastbill/fastbill.cjs create-invoice --data-json JSON --operator-grant [--dry-run]
  node skills/fastbill/fastbill.cjs mark-paid --invoice-id ID [--paid-date YYYY-MM-DD] [--payment-method TEXT] --operator-grant [--dry-run]
  node skills/fastbill/fastbill.cjs send-reminder --invoice-id ID --recipient EMAIL [--subject TEXT] [--message TEXT] --operator-grant [--dry-run]
  node skills/fastbill/fastbill.cjs export-einvoice --invoice-id ID [--dry-run]
  node skills/fastbill/fastbill.cjs plan "natural language request"
  node skills/fastbill/fastbill.cjs eval-scenarios

Environment:
  HYBRIDCLAW_GATEWAY_URL       Gateway URL, default ${DEFAULT_GATEWAY_URL}
  HYBRIDCLAW_GATEWAY_TOKEN     Optional gateway API token for direct helper request calls
  GATEWAY_API_TOKEN            Fallback gateway API token for direct helper request calls
  WEB_API_TOKEN                Fallback web API token accepted by the gateway
  FASTBILL_AUTH_SECRET_NAME    Stored secret name, default ${DEFAULT_AUTH_SECRET_NAME}
`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === 'help' || args.help) {
    printHelp();
    return;
  }
  const common = {
    dryRun: Boolean(args['dry-run']),
    operatorGrant: Boolean(args['operator-grant']),
    authSecretName:
      args['auth-secret-name'] ||
      process.env.FASTBILL_AUTH_SECRET_NAME ||
      DEFAULT_AUTH_SECRET_NAME,
    traceId: args['trace-id'],
  };

  if (command === 'plan') {
    printJson(planFastBillRequest(args._.slice(1).join(' ')));
    return;
  }

  if (command === 'eval-scenarios') {
    const result = evaluateScenarios();
    printJson(result);
    if (result.failed > 0) process.exitCode = 1;
    return;
  }

  if (command === 'http-request') {
    const service = args._[1];
    const filter = resolveJsonInput(args, 'filter');
    const data = resolveJsonInput(args, 'data');
    printJson(
      buildFastBillHttpRequest({
        ...common,
        service,
        filter,
        data,
        limit: parseNonNegativeInt(args.limit, '--limit'),
        offset: parseNonNegativeInt(args.offset, '--offset'),
      }),
    );
    return;
  }

  if (command === 'parse-response') {
    printJson(parseFastBillHttpResponse(resolveTextInput(args, 'body')));
    return;
  }

  if (command === 'request') {
    const service = args._[1];
    const filter = resolveJsonInput(args, 'filter');
    const data = resolveJsonInput(args, 'data');
    printJson(
      await callFastBillService({
        ...common,
        service,
        filter,
        data,
        limit: parseNonNegativeInt(args.limit, '--limit'),
        offset: parseNonNegativeInt(args.offset, '--offset'),
      }),
    );
    return;
  }

  if (command === 'list-invoices') {
    const filter = {};
    if (args['older-than-days'])
      filter.END_DUE_DATE = isoDateDaysAgo(args['older-than-days']);
    const limit = parseNonNegativeInt(args.limit, '--limit') ?? 100;
    const result = await callFastBillService({
      ...common,
      service: 'invoice.get',
      filter,
      limit,
      offset: parseNonNegativeInt(args.offset, '--offset'),
    });
    if (!common.dryRun) {
      const rawInvoices = findInvoices(result.response);
      result.invoices = filterInvoices(rawInvoices, {
        state: args.state,
      });
      if (rawInvoices.length === limit) {
        result.truncated = true;
        result.truncationNote =
          'Results may be incomplete. Use --limit and --offset to paginate.';
      }
    }
    printJson(result);
    return;
  }

  if (command === 'create-invoice') {
    const data = resolveJsonInput(args, 'data');
    printJson(
      await callFastBillService({
        ...common,
        service: 'invoice.create',
        data,
      }),
    );
    return;
  }

  if (command === 'mark-paid') {
    if (!args['invoice-id'])
      throw new FastBillConfigError('--invoice-id is required.');
    const data = {
      INVOICE_ID: args['invoice-id'],
      PAID_DATE: parseIsoDate(args['paid-date'], '--paid-date'),
      PAYMENT_METHOD: args['payment-method'],
    };
    printJson(
      await callFastBillService({
        ...common,
        service: 'invoice.setpaid',
        data,
      }),
    );
    return;
  }

  if (command === 'send-reminder') {
    if (!args['invoice-id'])
      throw new FastBillConfigError('--invoice-id is required.');
    if (!args.recipient)
      throw new FastBillConfigError('--recipient is required.');
    const data = {
      INVOICE_ID: args['invoice-id'],
      RECIPIENT: {
        TO: args.recipient,
      },
      SUBJECT: args.subject || 'Payment reminder',
      MESSAGE:
        args.message ||
        'Please review the outstanding invoice and payment status.',
    };
    printJson(
      await callFastBillService({
        ...common,
        service: 'invoice.sendbyemail',
        data,
      }),
    );
    return;
  }

  if (command === 'export-einvoice') {
    if (!args['invoice-id'])
      throw new FastBillConfigError('--invoice-id is required.');
    const einvoiceFixture = loadEInvoiceFixture();
    const result = await callFastBillService({
      ...common,
      service: 'invoice.get',
      filter: { INVOICE_ID: args['invoice-id'] },
    });
    result.einvoiceHandoff = {
      invoiceId: args['invoice-id'],
      source: 'FastBill invoice.get DOCUMENT_URL / invoice document metadata',
      formats: einvoiceFixture.formats,
      requiresAccountEInvoicingEnabled: true,
      validateWithEInvoicingFixtures: true,
      mandatoryBuyerChecks: einvoiceFixture.requiredBuyerChecks,
    };
    printJson(result);
    return;
  }

  throw new FastBillConfigError(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    const payload = {
      error: {
        name: error.name || 'Error',
        code: error.code || 'FASTBILL_ERROR',
        message: error.message,
        service: error.service,
        status: error.status,
        errors: error.errors,
      },
      costMeasurement: usageTotalsMeasurement(),
    };
    printJson(payload);
    process.exitCode = 1;
  });
}

module.exports = {
  API_URL,
  DEFAULT_AUTH_SECRET_NAME,
  READ_SERVICES,
  WRITE_SERVICES,
  SUPPORTED_SERVICES,
  FastBillApiError,
  FastBillConfigError,
  FastBillCredentialError,
  FastBillOperatorGrantError,
  buildFastBillHttpRequest,
  buildFastBillXmlRequest,
  callFastBillService,
  evaluateScenarios,
  loadEInvoiceFixture,
  parseFastBillHttpResponse,
  parseFastBillXmlResponse,
  planFastBillRequest,
  usageTotalsMeasurement,
};
