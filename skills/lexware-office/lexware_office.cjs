#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const API_BASE = 'https://api.lexware.io';
const DEFAULT_TIMEOUT_MS = 30000;
const TOKEN_SECRET = 'LEXWARE_OFFICE_API_KEY';
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');

const COST_MEASUREMENT = {
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

const READ_OPERATIONS = new Set([
  'profile',
  'list-contacts',
  'get-contact',
  'list-products',
  'get-product',
  'list-invoices',
  'get-invoice',
  'download-invoice-file',
  'list-expenses',
  'get-voucher',
  'get-payment',
  'list-bank-transactions',
  'posting-categories',
  'income-statement-plan',
  'revenue-summary-plan',
]);

const WRITE_OPERATIONS = new Set([
  'create-contact',
  'create-invoice',
  'log-expense',
  'upload-file',
  'attach-file-to-voucher',
  'update-voucher',
  'match-transaction',
]);

const INVOICE_RE = /\b(invoices?|rechnung|rechnungen|receivables?)\b/i;
const CUSTOMER_RE = /\b(customers?|clients?|contacts?|kunden?)\b/i;
const PRODUCT_RE = /\b(products?|articles?|items?|services?|artikel)\b/i;
const EXPENSE_RE =
  /\b(expenses?|receipts?|belege?|purchase\s*invoices?|reisekosten)\b/i;
const PAYMENT_RE =
  /\b(payments?|paid|unpaid|open amount|outstanding|overdue|late|mahn)\b/i;
const BANK_RE = /\b(bank|transaction|payment match|match incoming|konto)\b/i;
const REPORT_RE =
  /\b(income statement|p&l|profit and loss|einnahmen|revenue|quarter|q[1-4])\b/i;
const CREATE_RE =
  /\b(create|generate|draft|add|new|send|log|upload|attach|book|match|sync|erstell(?:e|en)?)\b/i;
const UPDATE_RE = /\b(update|change|correct|edit|void|remove|replace)\b/i;
const POSTING_RE =
  /\b(posting categories?|booking categor(?:y|ies)|category ids?|kontierungs?kategorien?)\b/i;
const FILE_RE = /\b(download|file|pdf|document)\b/i;
const READ_ONLY_VOUCHER_FIELDS = new Set([
  'id',
  'organizationId',
  'resourceUri',
  'createdDate',
  'updatedDate',
]);

function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function popFlag(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    die(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function popBoolean(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function parseJsonValue(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    die(`${label} must be valid JSON: ${error.message}`);
  }
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    die(`Cannot read JSON file ${filePath}: ${error.message}`);
  }
}

function unwrapJsonPayload(payload) {
  if (payload?.bodyJson) return payload.bodyJson;
  if (typeof payload?.body === 'string')
    return parseJsonValue(payload.body, 'body');
  return payload;
}

function loadJsonPayload(filePath) {
  return unwrapJsonPayload(loadJsonFile(filePath));
}

function validateUuid(value, label) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      String(value || ''),
    )
  ) {
    die(`${label} must be a UUID.`);
  }
}

function appendQuery(url, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function parsePageSize(raw) {
  if (!/^\d+$/.test(String(raw))) die('--size must be an integer.');
  const size = Number.parseInt(raw, 10);
  if (size < 1 || size > 250) die('--size must be between 1 and 250.');
  return size;
}

function buildHttpRequest({ url, method = 'GET', json, headers, bodyBase64 }) {
  const httpRequest = {
    url,
    method,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    bearerSecretName: TOKEN_SECRET,
    skillName: 'lexware-office',
  };
  if (json !== undefined) httpRequest.json = json;
  if (headers !== undefined) httpRequest.headers = headers;
  if (bodyBase64 !== undefined) httpRequest.bodyBase64 = bodyBase64;
  return {
    command: 'http-request',
    httpRequest,
    costMeasurement: COST_MEASUREMENT,
  };
}

function requireGrant(args, operation) {
  if (!popBoolean(args, '--operator-grant')) {
    die(
      `Refusing Lexware Office write without --operator-grant (${operation}). ` +
        'Run plan first and get an explicit operator grant.',
    );
  }
}

function requireJsonPayload(args) {
  const raw = popFlag(args, '--json');
  if (!raw) die('--json is required.');
  const payload = parseJsonValue(raw, '--json');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    die('--json must be a JSON object.');
  }
  return payload;
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.xml') return 'application/xml';
  return 'application/octet-stream';
}

function normalizeUploadFile(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) die(`--file must point to a file: ${filePath}`);
  return {
    path: resolved,
    filename: path.basename(resolved).replace(/["\r\n]/g, '_'),
    bytes: fs.readFileSync(resolved),
    mimeType: mimeTypeFor(resolved),
  };
}

function buildMultipartBody(parts) {
  const boundary = `----hybridclaw-lexware-${Date.now().toString(36)}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf-8'));
    if (part.filename) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.mimeType}\r\n\r\n`,
          'utf-8',
        ),
      );
      chunks.push(part.bytes);
      chunks.push(Buffer.from('\r\n', 'utf-8'));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          'utf-8',
        ),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
  return {
    boundary,
    bodyBase64: Buffer.concat(chunks).toString('base64'),
  };
}

function buildReadRequest(operation, args) {
  if (operation === 'profile') {
    return buildHttpRequest({ url: `${API_BASE}/v1/profile` });
  }
  if (operation === 'list-contacts') {
    const url = appendQuery(`${API_BASE}/v1/contacts`, {
      page: popFlag(args, '--page', '0'),
      size: parsePageSize(popFlag(args, '--size', '25')),
      email: popFlag(args, '--email'),
      name: popFlag(args, '--name'),
      number: popFlag(args, '--number'),
    });
    return buildHttpRequest({ url });
  }
  if (operation === 'get-contact') {
    const id = popFlag(args, '--id');
    validateUuid(id, '--id');
    return buildHttpRequest({ url: `${API_BASE}/v1/contacts/${id}` });
  }
  if (operation === 'list-products') {
    const url = appendQuery(`${API_BASE}/v1/articles`, {
      page: popFlag(args, '--page', '0'),
      size: parsePageSize(popFlag(args, '--size', '25')),
      articleNumber: popFlag(args, '--article-number'),
      type: popFlag(args, '--type'),
    });
    return buildHttpRequest({ url });
  }
  if (operation === 'get-product') {
    const id = popFlag(args, '--id');
    validateUuid(id, '--id');
    return buildHttpRequest({ url: `${API_BASE}/v1/articles/${id}` });
  }
  if (operation === 'list-invoices') {
    return buildVoucherListRequest(args, {
      voucherType: 'invoice',
      voucherStatus: popFlag(args, '--status'),
    });
  }
  if (operation === 'get-invoice') {
    const id = popFlag(args, '--id');
    validateUuid(id, '--id');
    return buildHttpRequest({ url: `${API_BASE}/v1/invoices/${id}` });
  }
  if (operation === 'download-invoice-file') {
    const id = popFlag(args, '--id');
    validateUuid(id, '--id');
    return buildHttpRequest({
      url: `${API_BASE}/v1/invoices/${id}/file`,
      headers: { Accept: '*/*' },
    });
  }
  if (operation === 'list-expenses') {
    return buildVoucherListRequest(args, {
      voucherType: 'purchaseinvoice,purchasecreditnote',
      voucherStatus: popFlag(args, '--status'),
    });
  }
  if (operation === 'get-voucher') {
    const id = popFlag(args, '--id');
    validateUuid(id, '--id');
    return buildHttpRequest({ url: `${API_BASE}/v1/vouchers/${id}` });
  }
  if (operation === 'get-payment') {
    const voucherId = popFlag(args, '--voucher-id');
    validateUuid(voucherId, '--voucher-id');
    return buildHttpRequest({ url: `${API_BASE}/v1/payments/${voucherId}` });
  }
  if (operation === 'list-bank-transactions') {
    return buildBankTransactionPlan(args);
  }
  if (operation === 'posting-categories') {
    return buildHttpRequest({ url: `${API_BASE}/v1/posting-categories` });
  }
  if (operation === 'income-statement-plan') return buildStatementPlan(args);
  if (operation === 'revenue-summary-plan') return buildRevenuePlan(args);
  die(`Unsupported read operation: ${operation}`);
}

function buildVoucherListRequest(args, defaults = {}) {
  const url = appendQuery(`${API_BASE}/v1/voucherlist`, {
    page: popFlag(args, '--page', '0'),
    size: parsePageSize(popFlag(args, '--size', '25')),
    voucherType: popFlag(args, '--voucher-type', defaults.voucherType),
    voucherStatus: popFlag(args, '--status', defaults.voucherStatus),
    voucherNumber: popFlag(args, '--voucher-number'),
    contactId: popFlag(args, '--contact-id'),
    voucherDateFrom: popFlag(args, '--start-date'),
    voucherDateTo: popFlag(args, '--end-date'),
  });
  return buildHttpRequest({ url });
}

function statementWindow(args) {
  return {
    startDate: popFlag(args, '--start-date'),
    endDate: popFlag(args, '--end-date'),
  };
}

function buildStatementPlan(args) {
  const originalArgs = [...args];
  const window = statementWindow(args);
  return {
    command: 'income-statement-plan',
    note: 'Lexware Office Public API does not expose a native income-statement endpoint. Use voucherlist plus posting categories and aggregate revenue and expenses locally.',
    requestSequence: [
      buildVoucherListRequest([...originalArgs], {
        voucherType: 'invoice,creditnote,salesinvoice,salescreditnote',
      }).httpRequest,
      buildVoucherListRequest([...originalArgs], {
        voucherType: 'purchaseinvoice,purchasecreditnote',
      }).httpRequest,
      buildHttpRequest({ url: `${API_BASE}/v1/posting-categories` })
        .httpRequest,
    ],
    window,
    costMeasurement: COST_MEASUREMENT,
  };
}

function buildRevenuePlan(args) {
  const originalArgs = [...args];
  const window = statementWindow(args);
  return {
    command: 'revenue-summary-plan',
    requestSequence: [
      buildVoucherListRequest([...originalArgs], {
        voucherType: 'invoice,creditnote,salesinvoice,salescreditnote',
      }).httpRequest,
    ],
    window,
    costMeasurement: COST_MEASUREMENT,
  };
}

function buildBankTransactionPlan(args) {
  const status = popFlag(args, '--status');
  const originalArgs = [...args];
  if (status && status !== 'any') {
    originalArgs.push('--status', status);
  }
  return {
    command: 'bank-transaction-plan',
    note: 'Lexware Office Public API exposes bank-linked payments as paymentItems with paymentItemType partPaymentFinancialTransaction on /v1/payments/{voucherId}. Fetch candidate vouchers first, then fetch payment details per voucher id.',
    requestSequence: [
      buildVoucherListRequest([...originalArgs], {
        voucherType:
          'invoice,creditnote,salesinvoice,salescreditnote,purchaseinvoice,purchasecreditnote',
        voucherStatus: status && status !== 'any' ? status : undefined,
      }).httpRequest,
    ],
    followUpRequestTemplate: {
      url: `${API_BASE}/v1/payments/{voucherId}`,
      method: 'GET',
      bearerSecretName: TOKEN_SECRET,
      skillName: 'lexware-office',
    },
    filterPaymentItemType: 'partPaymentFinancialTransaction',
    costMeasurement: COST_MEASUREMENT,
  };
}

function buildWriteRequest(operation, args) {
  requireGrant(args, operation);
  if (operation === 'create-contact') {
    return buildHttpRequest({
      url: `${API_BASE}/v1/contacts`,
      method: 'POST',
      json: requireJsonPayload(args),
    });
  }
  if (operation === 'create-invoice') {
    const finalize = popBoolean(args, '--finalize');
    return buildHttpRequest({
      url: appendQuery(`${API_BASE}/v1/invoices`, { finalize }),
      method: 'POST',
      json: requireJsonPayload(args),
    });
  }
  if (operation === 'log-expense') {
    return buildHttpRequest({
      url: `${API_BASE}/v1/vouchers`,
      method: 'POST',
      json: requireJsonPayload(args),
    });
  }
  if (operation === 'update-voucher') {
    const id = popFlag(args, '--id');
    validateUuid(id, '--id');
    return buildHttpRequest({
      url: `${API_BASE}/v1/vouchers/${id}`,
      method: 'PUT',
      json: requireJsonPayload(args),
    });
  }
  if (operation === 'upload-file') {
    return buildUploadRequest(args, `${API_BASE}/v1/files`, [
      { name: 'type', value: popFlag(args, '--type', 'voucher') },
    ]);
  }
  if (operation === 'attach-file-to-voucher') {
    const voucherId = popFlag(args, '--voucher-id');
    validateUuid(voucherId, '--voucher-id');
    return buildUploadRequest(
      args,
      `${API_BASE}/v1/vouchers/${voucherId}/files`,
    );
  }
  if (operation === 'match-transaction') {
    return buildMatchTransactionWriteRequest(args);
  }
  die(`Unsupported write operation: ${operation}`);
}

function buildMatchTransactionWriteRequest(args) {
  const voucherId = popFlag(args, '--voucher-id');
  validateUuid(voucherId, '--voucher-id');
  const voucherRaw = popFlag(args, '--voucher-json');
  const transactionRaw = popFlag(args, '--transaction-json');
  if (!voucherRaw) die('--voucher-json is required.');
  if (!transactionRaw) die('--transaction-json is required.');
  const voucher = parseJsonValue(voucherRaw, '--voucher-json');
  const transaction = parseJsonValue(transactionRaw, '--transaction-json');
  const updatePayload = buildVoucherMatchAnnotation(voucher, transaction);
  return buildHttpRequest({
    url: `${API_BASE}/v1/vouchers/${voucherId}`,
    method: 'PUT',
    json: updatePayload,
  });
}

function buildVoucherMatchAnnotation(voucher, transaction) {
  if (!voucher || typeof voucher !== 'object' || Array.isArray(voucher)) {
    die('--voucher-json must be a JSON object.');
  }
  if (voucher.version === undefined || voucher.version === null) {
    die('--voucher-json must include the current Lexware voucher version.');
  }
  const output = {};
  for (const [key, value] of Object.entries(voucher)) {
    if (!READ_ONLY_VOUCHER_FIELDS.has(key)) output[key] = value;
  }
  const amount =
    transaction.amount ?? transaction.value ?? transaction.totalAmount;
  const bookingDate =
    transaction.bookingDate ?? transaction.postingDate ?? transaction.date;
  const transactionId =
    transaction.id ??
    transaction.transactionId ??
    transaction.endToEndId ??
    transaction.reference ??
    'unreferenced';
  const counterparty =
    transaction.counterpartyName ??
    transaction.name ??
    transaction.debtorName ??
    transaction.creditorName ??
    'unknown counterparty';
  const note =
    `HybridClaw bank match: transaction ${transactionId}, ${counterparty}, ` +
    `${amount ?? 'unknown amount'} EUR, ${bookingDate ?? 'unknown date'}.`;
  output.remark = appendRemark(voucher.remark, note);
  return output;
}

function appendRemark(currentRemark, note) {
  const base = String(currentRemark || '').trim();
  if (!base) return note;
  if (base.includes(note)) return base;
  return `${base}\n${note}`;
}

function buildUploadRequest(args, url, extraParts = []) {
  const filePath = popFlag(args, '--file');
  if (!filePath) die('--file is required.');
  const file = normalizeUploadFile(filePath);
  const multipart = buildMultipartBody([
    ...extraParts,
    {
      name: 'file',
      filename: file.filename,
      mimeType: file.mimeType,
      bytes: file.bytes,
    },
  ]);
  return buildHttpRequest({
    url,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
    },
    bodyBase64: multipart.bodyBase64,
  });
}

function makePlan({
  request,
  operation,
  resource,
  stakesTier = 'green',
  requiresEscalation = false,
  requiredGrant = null,
  executable = true,
  findings = [],
}) {
  return {
    command: 'plan',
    request,
    operation,
    resource,
    stakesTier,
    requiresEscalation,
    requiredGrant,
    executable,
    findings,
    costMeasurement: COST_MEASUREMENT,
  };
}

function planRequest(request) {
  const text = request.toLowerCase();
  const isWrite = CREATE_RE.test(text) || UPDATE_RE.test(text);

  if (BANK_RE.test(text) && isWrite) {
    return makePlan({
      request,
      operation: 'match-transaction',
      resource: 'payments',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: 'approve-lexware-office-transaction-match',
      executable: true,
      findings: [
        'Lexware Office Public API exposes bank-linked payment reads but no direct bank-assignment mutation. This write path creates an operator-approved voucher reconciliation note through the documented voucher update endpoint.',
      ],
    });
  }
  if (EXPENSE_RE.test(text) && isWrite) {
    return makePlan({
      request,
      operation: 'log-expense',
      resource: 'vouchers',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: 'approve-lexware-office-log-expense',
    });
  }
  if (INVOICE_RE.test(text) && isWrite) {
    return makePlan({
      request,
      operation: 'create-invoice',
      resource: 'invoices',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: 'approve-lexware-office-create-invoice',
    });
  }
  if (CUSTOMER_RE.test(text) && isWrite) {
    return makePlan({
      request,
      operation: 'create-contact',
      resource: 'contacts',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: 'approve-lexware-office-create-contact',
    });
  }
  if (BANK_RE.test(text) || PAYMENT_RE.test(text)) {
    return makePlan({
      request,
      operation: BANK_RE.test(text) ? 'list-bank-transactions' : 'get-payment',
      resource: 'payments',
    });
  }
  if (REPORT_RE.test(text)) {
    return makePlan({
      request,
      operation: text.includes('revenue')
        ? 'revenue-summary-plan'
        : 'income-statement-plan',
      resource: 'voucherlist',
    });
  }
  if (POSTING_RE.test(text)) {
    return makePlan({
      request,
      operation: 'posting-categories',
      resource: 'posting-categories',
    });
  }
  if (EXPENSE_RE.test(text)) {
    return makePlan({
      request,
      operation: 'list-expenses',
      resource: 'voucherlist',
    });
  }
  if (PRODUCT_RE.test(text)) {
    return makePlan({
      request,
      operation: 'list-products',
      resource: 'articles',
    });
  }
  if (INVOICE_RE.test(text) && FILE_RE.test(text)) {
    return makePlan({
      request,
      operation: 'download-invoice-file',
      resource: 'invoices',
    });
  }
  if (CUSTOMER_RE.test(text)) {
    return makePlan({
      request,
      operation: 'list-contacts',
      resource: 'contacts',
    });
  }
  return makePlan({
    request,
    operation: INVOICE_RE.test(text) ? 'list-invoices' : 'profile',
    resource: INVOICE_RE.test(text) ? 'voucherlist' : 'profile',
  });
}

function runEvalScenarios() {
  const scenarios = loadJsonFile(EVAL_SCENARIOS_PATH);
  const failures = [];
  const categories = {};
  for (const scenario of scenarios) {
    categories[scenario.category] = (categories[scenario.category] ?? 0) + 1;
    const plan = planRequest(scenario.prompt);
    for (const [key, expectedValue] of Object.entries(
      scenario.expected ?? {},
    )) {
      const actualValue =
        key === 'costSystem' ? plan.costMeasurement.system : plan[key];
      if (actualValue !== expectedValue) {
        failures.push({
          id: scenario.id,
          key,
          expected: expectedValue,
          actual: actualValue,
        });
      }
    }
  }
  return {
    command: 'eval-scenarios',
    scenarioCount: scenarios.length,
    failed: failures.length,
    failures,
    categories,
    costMeasurement: COST_MEASUREMENT,
  };
}

function normalizeContentList(payload) {
  const data = unwrapJsonPayload(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.vouchers)) return data.vouchers;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function amountValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function voucherAmount(voucher) {
  return amountValue(
    voucher.totalAmount ??
      voucher.totalGrossAmount ??
      voucher.totalPrice?.totalGrossAmount ??
      voucher.totalPrice?.totalNetAmount,
  );
}

function voucherSign(voucher) {
  const type = String(voucher.voucherType ?? voucher.type ?? '').toLowerCase();
  return type.includes('creditnote') ? -1 : 1;
}

function signedVoucherAmount(voucher) {
  return voucherSign(voucher) * voucherAmount(voucher);
}

function categoryBreakdown(vouchers) {
  const categories = {};
  for (const voucher of vouchers) {
    const sign = voucherSign(voucher);
    for (const item of voucher.voucherItems ?? []) {
      const categoryId = item.categoryId || 'uncategorized';
      categories[categoryId] =
        amountValue(categories[categoryId]) + sign * amountValue(item.amount);
    }
  }
  return categories;
}

function buildIncomeStatement(args) {
  const revenueFile = popFlag(args, '--revenue-file');
  const expenseFile = popFlag(args, '--expense-file');
  const categoriesFile = popFlag(args, '--categories-file');
  const startDate = popFlag(args, '--start-date');
  const endDate = popFlag(args, '--end-date');
  if (!revenueFile) die('--revenue-file is required.');
  if (!expenseFile) die('--expense-file is required.');
  const revenueVouchers = normalizeContentList(loadJsonPayload(revenueFile));
  const expenseVouchers = normalizeContentList(loadJsonPayload(expenseFile));
  const totalRevenue = revenueVouchers.reduce(
    (sum, voucher) => sum + signedVoucherAmount(voucher),
    0,
  );
  const totalExpenses = expenseVouchers.reduce(
    (sum, voucher) => sum + signedVoucherAmount(voucher),
    0,
  );
  const categories = categoriesFile ? loadJsonPayload(categoriesFile) : null;
  return {
    command: 'income-statement',
    currency: 'EUR',
    period: { startDate, endDate },
    totals: {
      revenue: roundMoney(totalRevenue),
      expenses: roundMoney(totalExpenses),
      netIncome: roundMoney(totalRevenue - totalExpenses),
    },
    counts: {
      revenueVouchers: revenueVouchers.length,
      expenseVouchers: expenseVouchers.length,
    },
    categoryBreakdown: {
      revenue: categoryBreakdown(revenueVouchers),
      expenses: categoryBreakdown(expenseVouchers),
    },
    categories,
    costMeasurement: COST_MEASUREMENT,
  };
}

function buildRevenueSummary(args) {
  const revenueFile = popFlag(args, '--revenue-file');
  if (!revenueFile) die('--revenue-file is required.');
  const revenueVouchers = normalizeContentList(loadJsonPayload(revenueFile));
  const totalRevenue = revenueVouchers.reduce(
    (sum, voucher) => sum + signedVoucherAmount(voucher),
    0,
  );
  return {
    command: 'revenue-summary',
    currency: 'EUR',
    totalRevenue: roundMoney(totalRevenue),
    voucherCount: revenueVouchers.length,
    categoryBreakdown: categoryBreakdown(revenueVouchers),
    costMeasurement: COST_MEASUREMENT,
  };
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function buildTransactionMatch(args) {
  const transactionRaw = popFlag(args, '--transaction-json');
  const invoicesFile = popFlag(args, '--invoices-file');
  const threshold = Number(popFlag(args, '--threshold', '0.75'));
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    die('--threshold must be a number between 0 and 1.');
  }
  if (!transactionRaw) die('--transaction-json is required.');
  if (!invoicesFile) die('--invoices-file is required.');
  const transaction = parseJsonValue(transactionRaw, '--transaction-json');
  const invoices = normalizeContentList(loadJsonPayload(invoicesFile));
  const candidates = invoices
    .map((invoice) => scoreInvoiceMatch(invoice, transaction))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? null;
  return {
    command: 'match-transaction',
    transaction,
    threshold,
    bestMatch: best,
    candidates,
    matched: Boolean(best && best.score >= threshold),
    writeOperation:
      best && best.score >= threshold ? 'http-request match-transaction' : null,
    costMeasurement: COST_MEASUREMENT,
  };
}

function scoreInvoiceMatch(invoice, transaction) {
  const reasons = [];
  let score = 0;
  const amount = Math.abs(amountValue(transaction.amount ?? transaction.value));
  const openAmount = Math.abs(
    amountValue(invoice.openAmount ?? voucherAmount(invoice)),
  );
  if (amount > 0 && openAmount > 0) {
    const delta = Math.abs(amount - openAmount);
    if (delta < 0.01) {
      score += 0.55;
      reasons.push('amount-exact');
    } else if (delta <= 1) {
      score += 0.35;
      reasons.push('amount-near');
    }
  }
  const memo = String(
    transaction.purpose ??
      transaction.remittanceInformation ??
      transaction.description ??
      '',
  ).toLowerCase();
  const voucherNumber = String(
    invoice.voucherNumber ?? invoice.number ?? '',
  ).toLowerCase();
  if (voucherNumber && memo.includes(voucherNumber)) {
    score += 0.3;
    reasons.push('voucher-number');
  }
  const contactName = String(
    invoice.contactName ?? invoice.address?.name ?? '',
  ).toLowerCase();
  if (contactName && memo.includes(contactName)) {
    score += 0.15;
    reasons.push('contact-name');
  }
  return {
    voucherId: invoice.id,
    voucherNumber: invoice.voucherNumber ?? invoice.number ?? null,
    contactName: invoice.contactName ?? invoice.address?.name ?? null,
    openAmount: invoice.openAmount ?? null,
    totalAmount: voucherAmount(invoice),
    score: roundMoney(Math.min(score, 1)),
    reasons,
  };
}

function handleHttpRequest(args) {
  const operation = args.shift();
  if (!operation) die('http-request requires an operation.');
  if (READ_OPERATIONS.has(operation)) return buildReadRequest(operation, args);
  if (WRITE_OPERATIONS.has(operation))
    return buildWriteRequest(operation, args);
  die(`Unknown Lexware Office operation: ${operation}`);
}

function usage() {
  return `Lexware Office skill helper

Usage:
  node skills/lexware-office/lexware_office.cjs --help
  node skills/lexware-office/lexware_office.cjs plan "natural language request"
  node skills/lexware-office/lexware_office.cjs http-request profile
  node skills/lexware-office/lexware_office.cjs http-request list-contacts [--name NAME] [--email EMAIL] [--page N] [--size N]
  node skills/lexware-office/lexware_office.cjs http-request get-contact --id UUID
  node skills/lexware-office/lexware_office.cjs http-request list-products [--article-number VALUE] [--type PRODUCT|SERVICE] [--page N] [--size N]
  node skills/lexware-office/lexware_office.cjs http-request list-invoices [--status open] [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--page N] [--size N]
  node skills/lexware-office/lexware_office.cjs http-request get-invoice --id UUID
  node skills/lexware-office/lexware_office.cjs http-request list-expenses [--status open] [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--page N] [--size N]
  node skills/lexware-office/lexware_office.cjs http-request get-voucher --id UUID
  node skills/lexware-office/lexware_office.cjs http-request get-payment --voucher-id UUID
  node skills/lexware-office/lexware_office.cjs http-request list-bank-transactions [--status any]
  node skills/lexware-office/lexware_office.cjs http-request posting-categories
  node skills/lexware-office/lexware_office.cjs http-request income-statement-plan --start-date YYYY-MM-DD --end-date YYYY-MM-DD
  node skills/lexware-office/lexware_office.cjs income-statement --revenue-file PATH --expense-file PATH [--categories-file PATH]
  node skills/lexware-office/lexware_office.cjs revenue-summary --revenue-file PATH
  node skills/lexware-office/lexware_office.cjs match-transaction --transaction-json JSON --invoices-file PATH
  node skills/lexware-office/lexware_office.cjs http-request create-contact --json JSON --operator-grant
  node skills/lexware-office/lexware_office.cjs http-request create-invoice --json JSON [--finalize] --operator-grant
  node skills/lexware-office/lexware_office.cjs http-request log-expense --json JSON --operator-grant
  node skills/lexware-office/lexware_office.cjs http-request upload-file --file PATH [--type voucher] --operator-grant
  node skills/lexware-office/lexware_office.cjs http-request attach-file-to-voucher --voucher-id UUID --file PATH --operator-grant
  node skills/lexware-office/lexware_office.cjs http-request match-transaction --voucher-id UUID --voucher-json JSON --transaction-json JSON --operator-grant
  node skills/lexware-office/lexware_office.cjs eval-scenarios
`;
}

function main() {
  const args = process.argv.slice(2);
  const format = popFlag(args, '--format', 'json');
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(usage());
    return;
  }

  const command = args.shift();
  let payload;
  if (command === 'plan') {
    const request = args.join(' ').trim();
    if (!request) die('plan requires a request.');
    payload = planRequest(request);
  } else if (command === 'http-request') {
    payload = handleHttpRequest(args);
  } else if (command === 'income-statement') {
    payload = buildIncomeStatement(args);
  } else if (command === 'revenue-summary') {
    payload = buildRevenueSummary(args);
  } else if (command === 'match-transaction') {
    payload = buildTransactionMatch(args);
  } else if (command === 'eval-scenarios') {
    payload = runEvalScenarios();
  } else {
    die(`Unknown command: ${command}`);
  }

  if (format === 'json') {
    printJson(payload);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (require.main === module) main();

module.exports = {
  planRequest,
  runEvalScenarios,
  buildIncomeStatement,
  buildTransactionMatch,
};
