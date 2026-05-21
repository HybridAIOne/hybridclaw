#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const API_BASE = 'https://api.lexware.io/v1';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_BEARER_SECRET_NAME = 'LEXWARE_OFFICE_API_KEY';
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');
const MULTIPART_BOUNDARY_PREFIX = '----hybridclaw-lexware-office-';

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

const OPERATION_DEFINITIONS = {
  profile: {
    method: 'GET',
    path: '/profile',
    read: true,
  },
  'list-customers': {
    method: 'GET',
    path: '/contacts',
    read: true,
    paged: true,
    queryKeys: ['email', 'name', 'number', 'customer', 'vendor'],
    htmlEncodedQueryKeys: ['email', 'name'],
  },
  'get-customer': {
    method: 'GET',
    path: '/contacts/{id}',
    read: true,
    needsId: true,
  },
  'list-products': {
    method: 'GET',
    path: '/articles',
    read: true,
    paged: true,
  },
  'get-product': {
    method: 'GET',
    path: '/articles/{id}',
    read: true,
    needsId: true,
  },
  'list-invoices': {
    method: 'GET',
    path: '/voucherlist',
    read: true,
    paged: true,
    defaults: {
      voucherType: 'invoice,downpaymentinvoice',
      voucherStatus: 'open,paid,paidoff,draft',
    },
    queryKeys: [
      'voucherType',
      'voucherStatus',
      'voucherNumber',
      'voucherDateFrom',
      'voucherDateTo',
      'updatedDateFrom',
      'updatedDateTo',
      'archived',
    ],
    htmlEncodedQueryKeys: ['voucherNumber'],
  },
  'get-invoice': {
    method: 'GET',
    path: '/invoices/{id}',
    read: true,
    needsId: true,
  },
  'invoice-file': {
    method: 'GET',
    path: '/invoices/{id}/file',
    read: true,
    needsId: true,
    accept: '*/*',
  },
  'download-file': {
    method: 'GET',
    path: '/files/{id}',
    read: true,
    needsId: true,
    accept: '*/*',
  },
  'list-expenses': {
    method: 'GET',
    path: '/voucherlist',
    read: true,
    paged: true,
    defaults: {
      voucherType: 'purchaseinvoice,purchasecreditnote',
      voucherStatus: 'open,paid,paidoff,unchecked',
    },
    queryKeys: [
      'voucherType',
      'voucherStatus',
      'voucherNumber',
      'voucherDateFrom',
      'voucherDateTo',
      'updatedDateFrom',
      'updatedDateTo',
      'archived',
    ],
    htmlEncodedQueryKeys: ['voucherNumber'],
  },
  'get-voucher': {
    method: 'GET',
    path: '/vouchers/{id}',
    read: true,
    needsId: true,
  },
  'payment-status': {
    method: 'GET',
    path: '/payments/{id}',
    read: true,
    needsId: true,
  },
  'posting-categories': {
    method: 'GET',
    path: '/posting-categories',
    read: true,
  },
  'create-invoice': {
    method: 'POST',
    path: '/invoices',
    write: true,
    bodyRequired: true,
    grant: 'approve-lexware-office-invoice-create',
  },
  'log-expense': {
    method: 'POST',
    path: '/vouchers',
    write: true,
    bodyRequired: true,
    grant: 'approve-lexware-office-expense-log',
  },
  'upload-file': {
    method: 'POST',
    path: '/files',
    write: true,
    fileRequired: true,
    grant: 'approve-lexware-office-file-upload',
  },
  'attach-voucher-file': {
    method: 'POST',
    path: '/vouchers/{id}/files',
    write: true,
    fileRequired: true,
    needsId: true,
    grant: 'approve-lexware-office-voucher-file-attach',
  },
};

const READ_OPERATIONS = new Set(
  Object.entries(OPERATION_DEFINITIONS)
    .filter(([, definition]) => definition.read)
    .map(([operation]) => operation),
);
const WRITE_OPERATIONS = new Set(
  Object.entries(OPERATION_DEFINITIONS)
    .filter(([, definition]) => definition.write)
    .map(([operation]) => operation),
);
const VIRTUAL_OPERATIONS = new Set([
  'income-statement',
  'list-bank-transactions',
  'match-transaction',
]);
const SUPPORTED_OPERATIONS = new Set([
  ...READ_OPERATIONS,
  ...WRITE_OPERATIONS,
  ...VIRTUAL_OPERATIONS,
]);

class LexwareOfficeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LexwareOfficeConfigError';
    this.code = 'LEXWARE_OFFICE_CONFIG_ERROR';
  }
}

class LexwareOfficeOperatorGrantError extends Error {
  constructor(operation, grant) {
    super(
      `Lexware Office operation ${operation} mutates accounting data and requires --operator-grant (${grant}).`,
    );
    this.name = 'LexwareOfficeOperatorGrantError';
    this.code = 'LEXWARE_OFFICE_OPERATOR_GRANT_REQUIRED';
    this.operation = operation;
    this.requiredGrant = grant;
  }
}

function usageTotalsMeasurement() {
  return { ...COST_MEASUREMENT, fields: [...COST_MEASUREMENT.fields] };
}

function normalizeOperation(operation) {
  const normalized = String(operation || '')
    .trim()
    .toLowerCase();
  if (!SUPPORTED_OPERATIONS.has(normalized)) {
    throw new LexwareOfficeConfigError(
      `Unsupported Lexware Office operation: ${operation}`,
    );
  }
  return normalized;
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
    if (['dry-run', 'operator-grant', 'finalize', 'help'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new LexwareOfficeConfigError(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonValue(raw, label) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new LexwareOfficeConfigError(
      `${label} is not valid JSON: ${error.message}`,
    );
  }
}

function parseJsonFile(filePath, label) {
  if (!filePath) return undefined;
  try {
    return parseJsonValue(
      fs.readFileSync(path.resolve(filePath), 'utf8'),
      label,
    );
  } catch (error) {
    if (error instanceof LexwareOfficeConfigError) throw error;
    throw new LexwareOfficeConfigError(
      `Cannot read ${label} JSON file ${filePath}: ${error.message}`,
    );
  }
}

function resolveJsonInput(args, label) {
  const inline = parseJsonValue(args[`${label}-json`], label);
  const file = parseJsonFile(args[`${label}-file`], label);
  if (inline !== undefined && file !== undefined) {
    throw new LexwareOfficeConfigError(
      `Use either --${label}-json or --${label}-file, not both.`,
    );
  }
  return inline ?? file;
}

function parsePositiveInt(value, flag, max = 250) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!/^\d+$/u.test(String(value))) {
    throw new LexwareOfficeConfigError(`${flag} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) {
    throw new LexwareOfficeConfigError(`${flag} must be between 1 and ${max}.`);
  }
  return parsed;
}

function parsePage(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!/^\d+$/u.test(String(value))) {
    throw new LexwareOfficeConfigError(
      '--page must be a non-negative integer.',
    );
  }
  return Number(value);
}

function parseIsoDate(value, flag) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value))) {
    throw new LexwareOfficeConfigError(`${flag} must use YYYY-MM-DD format.`);
  }
  return value;
}

function resolveFileUpload(input) {
  if (!input.filePath) {
    throw new LexwareOfficeConfigError(
      '--file is required for this operation.',
    );
  }
  const filePath = path.resolve(input.filePath);
  let file;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new LexwareOfficeConfigError(
        `--file is not a file: ${input.filePath}`,
      );
    }
    file = fs.readFileSync(filePath);
  } catch (error) {
    if (error instanceof LexwareOfficeConfigError) throw error;
    throw new LexwareOfficeConfigError(
      `Cannot read upload file ${input.filePath}: ${error.message}`,
    );
  }
  return {
    file,
    filename: input.filename || path.basename(filePath),
    mimeType: input.mimeType || guessMimeType(filePath),
  };
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.xml') return 'application/xml';
  return 'application/octet-stream';
}

function sanitizeMultipartToken(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new LexwareOfficeConfigError(`${label} must not be empty.`);
  if (/[\r\n"]/u.test(text)) {
    throw new LexwareOfficeConfigError(
      `${label} must not contain quotes or newlines.`,
    );
  }
  return text;
}

function buildMultipartBody(parts) {
  const boundary = `${MULTIPART_BOUNDARY_PREFIX}${Date.now().toString(36)}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    const name = sanitizeMultipartToken(part.name, 'multipart part name');
    if (part.file) {
      const filename = sanitizeMultipartToken(part.filename, 'filename');
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${part.mimeType}\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(part.value);
      chunks.push(Buffer.from('\r\n', 'utf8'));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${name}"\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(Buffer.from(String(part.value), 'utf8'));
      chunks.push(Buffer.from('\r\n', 'utf8'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    bodyBase64: Buffer.concat(chunks).toString('base64'),
  };
}

function htmlEncodeSearchValue(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function appendQuery(url, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) search.append(key, String(entry));
    } else {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `${url}?${query}` : url;
}

function buildQuery(definition, inputQuery = {}, input = {}) {
  const allowed = new Set([...(definition.queryKeys || []), 'page', 'size']);
  const htmlEncoded = new Set(definition.htmlEncodedQueryKeys || []);
  const query = { ...(definition.defaults || {}) };

  for (const [key, value] of Object.entries(inputQuery || {})) {
    if (allowed.size > 2 && !allowed.has(key)) {
      throw new LexwareOfficeConfigError(
        `Unsupported query parameter for this operation: ${key}`,
      );
    }
    query[key] = htmlEncoded.has(key) ? htmlEncodeSearchValue(value) : value;
  }
  if (definition.paged) {
    query.page = parsePage(input.page) ?? query.page ?? 0;
    query.size = parsePositiveInt(input.size, '--size') ?? query.size ?? 100;
  }
  return query;
}

function buildUrl(definition, input) {
  if (definition.needsId && !input.id) {
    throw new LexwareOfficeConfigError('--id is required for this operation.');
  }
  const pathWithId = definition.path.replace(
    '{id}',
    encodeURIComponent(input.id || ''),
  );
  const query = buildQuery(definition, input.query, input);
  if (input.finalize && definition.path === '/invoices') {
    query.finalize = 'true';
  }
  return appendQuery(`${API_BASE}${pathWithId}`, query);
}

function assertOperatorGrant(operation, definition, hasGrant, dryRun) {
  if (definition.write && !hasGrant && !dryRun) {
    throw new LexwareOfficeOperatorGrantError(operation, definition.grant);
  }
}

function buildHttpRequest(input) {
  const operation = normalizeOperation(input.operation);
  const definition = OPERATION_DEFINITIONS[operation];
  if (!definition) {
    if (operation === 'income-statement')
      return buildIncomeStatementPlan(input);
    if (operation === 'list-bank-transactions')
      return buildBankTransactionLimitation();
    if (operation === 'match-transaction')
      return buildTransactionMatchHandoff(input);
  }
  assertOperatorGrant(
    operation,
    definition,
    Boolean(input.operatorGrant),
    Boolean(input.dryRun),
  );
  if (definition.bodyRequired && !input.body) {
    throw new LexwareOfficeConfigError(
      '--body-json or --body-file is required.',
    );
  }
  if (definition.fileRequired && !input.filePath) {
    throw new LexwareOfficeConfigError(
      '--file is required for this operation.',
    );
  }
  const request = {
    url: buildUrl(definition, input),
    method: definition.method,
    headers: {
      Accept: definition.accept || 'application/json',
    },
    timeoutMs: input.timeoutMs || DEFAULT_TIMEOUT_MS,
    bearerSecretName: input.bearerSecretName || DEFAULT_BEARER_SECRET_NAME,
    skillName: 'lexware-office',
  };
  if (definition.fileRequired) {
    const upload = resolveFileUpload(input);
    const parts =
      operation === 'upload-file'
        ? [
            { name: 'type', value: input.uploadType || 'voucher' },
            {
              name: 'file',
              value: upload.file,
              file: true,
              filename: upload.filename,
              mimeType: upload.mimeType,
            },
          ]
        : [
            {
              name: 'file',
              value: upload.file,
              file: true,
              filename: upload.filename,
              mimeType: upload.mimeType,
            },
          ];
    const multipart = buildMultipartBody(parts);
    request.headers['Content-Type'] =
      `multipart/form-data; boundary=${multipart.boundary}`;
    request.bodyBase64 = multipart.bodyBase64;
  } else if (definition.method !== 'GET') {
    request.headers['Content-Type'] = 'application/json';
    request.json = input.body;
  }
  if (input.traceId) request.headers['x-trace-id'] = input.traceId;
  return {
    operation,
    mutatesAccount: Boolean(definition.write),
    requiredGrant: definition.grant || null,
    dryRun: Boolean(input.dryRun),
    httpRequest: request,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function buildIncomeStatementPlan(input = {}) {
  const from = parseIsoDate(input.from, '--from');
  const to = parseIsoDate(input.to, '--to');
  if (!from || !to) {
    throw new LexwareOfficeConfigError(
      'income-statement requires --from YYYY-MM-DD and --to YYYY-MM-DD.',
    );
  }
  const common = {
    voucherDateFrom: from,
    voucherDateTo: to,
  };
  return {
    operation: 'income-statement',
    mutatesAccount: false,
    basis:
      'Derived from voucherlist revenue and expense voucher metadata; Lexware Public API does not expose a dedicated BWA/P&L endpoint.',
    sourceRequests: [
      buildHttpRequest({
        operation: 'list-invoices',
        query: {
          ...common,
          voucherType:
            'invoice,downpaymentinvoice,salesinvoice,salescreditnote',
          voucherStatus: 'open,paid,paidoff',
        },
        page: input.page,
        size: input.size,
        bearerSecretName: input.bearerSecretName,
      }).httpRequest,
      buildHttpRequest({
        operation: 'list-expenses',
        query: {
          ...common,
          voucherType: 'purchaseinvoice,purchasecreditnote',
          voucherStatus: 'open,paid,paidoff',
        },
        page: input.page,
        size: input.size,
        bearerSecretName: input.bearerSecretName,
      }).httpRequest,
    ],
    aggregation: {
      revenueVoucherTypes: ['invoice', 'downpaymentinvoice', 'salesinvoice'],
      contraRevenueVoucherTypes: ['salescreditnote'],
      expenseVoucherTypes: ['purchaseinvoice', 'purchasecreditnote'],
      amountFields: ['totalAmount', 'totalGrossAmount', 'openAmount'],
      currency: 'EUR',
    },
    costMeasurement: usageTotalsMeasurement(),
  };
}

function buildBankTransactionLimitation() {
  return {
    operation: 'list-bank-transactions',
    mutatesAccount: false,
    apiLimitation:
      'The Lexware Public API exposes voucher payment status through /payments/{id}, but not a raw bank-transaction feed.',
    supportedReadPath:
      'Use bank-transactions-from-payments after collecting /payments/{voucherId} responses; it extracts paymentItems with type partPaymentFinancialTransaction.',
    costMeasurement: usageTotalsMeasurement(),
  };
}

function buildTransactionMatchHandoff(input = {}) {
  if (!input.operatorGrant && !input.dryRun) {
    throw new LexwareOfficeOperatorGrantError(
      'match-transaction',
      'approve-lexware-office-transaction-match',
    );
  }
  return {
    operation: 'match-transaction',
    mutatesAccount: true,
    requiredGrant: 'approve-lexware-office-transaction-match',
    apiLimitation:
      'The Lexware Public API does not expose a transaction-matching write endpoint. Use this as an operator-approved manual handoff in Lexware Office.',
    manualHandoff: {
      transactionId: input.transactionId || null,
      voucherId: input.voucherId || input.invoiceId || null,
      expectedAction:
        'Open Lexware Office bank transactions, verify amount/date/counterparty, and match the transaction to the selected voucher.',
    },
    costMeasurement: usageTotalsMeasurement(),
  };
}

function unwrapGatewayBody(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value && typeof value === 'object') {
    if (value.bodyJson !== undefined) return value.bodyJson;
    if (value.json !== undefined) return value.json;
    if (typeof value.body === 'string') {
      try {
        return JSON.parse(value.body);
      } catch {
        return value.body;
      }
    }
  }
  return value;
}

function collectObjects(value) {
  const unwrapped = unwrapGatewayBody(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  if (!unwrapped || typeof unwrapped !== 'object') return [];
  if (Array.isArray(unwrapped.content)) return unwrapped.content;
  if (Array.isArray(unwrapped.items)) return unwrapped.items;
  if (Array.isArray(unwrapped.vouchers)) return unwrapped.vouchers;
  return [unwrapped];
}

function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function voucherAmount(voucher) {
  return amount(
    voucher.totalAmount ??
      voucher.totalGrossAmount ??
      voucher.amount ??
      voucher.openAmount,
  );
}

function aggregateIncomeStatement(input = {}) {
  const revenueItems = collectObjects(input.revenue);
  const expenseItems = collectObjects(input.expenses);
  const revenue = revenueItems.reduce((sum, item) => {
    const type = String(item.voucherType || item.type || '').toLowerCase();
    const sign = type.includes('creditnote') ? -1 : 1;
    return sum + sign * voucherAmount(item);
  }, 0);
  const expenses = expenseItems.reduce(
    (sum, item) => sum + voucherAmount(item),
    0,
  );
  return {
    operation: 'income-statement',
    mutatesAccount: false,
    basis: 'Derived from Lexware voucherlist response payloads.',
    period: {
      from: input.from || null,
      to: input.to || null,
    },
    totals: {
      revenue: Number(revenue.toFixed(2)),
      expenses: Number(expenses.toFixed(2)),
      netIncome: Number((revenue - expenses).toFixed(2)),
      currency: 'EUR',
    },
    sourceCounts: {
      revenueVouchers: revenueItems.length,
      expenseVouchers: expenseItems.length,
    },
    costMeasurement: usageTotalsMeasurement(),
  };
}

function extractBankTransactionsFromPayments(input = {}) {
  const payments = collectObjects(input.payments);
  const transactions = [];
  for (const payment of payments) {
    const items = Array.isArray(payment.paymentItems)
      ? payment.paymentItems
      : [];
    for (const item of items) {
      if (item.paymentItemType !== 'partPaymentFinancialTransaction') continue;
      transactions.push({
        voucherId: payment.voucherId || payment.id || input.voucherId || null,
        voucherType: payment.voucherType || null,
        voucherStatus: payment.voucherStatus || null,
        postingDate: item.postingDate || null,
        amount: amount(item.amount),
        currency: item.currency || payment.currency || 'EUR',
        paymentItemType: item.paymentItemType,
      });
    }
  }
  return {
    operation: 'list-bank-transactions',
    mutatesAccount: false,
    source: 'Extracted from Lexware /payments/{voucherId} paymentItems.',
    transactions,
    transactionCount: transactions.length,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function planLexwareOfficeRequest(text) {
  const raw = String(text || '').trim();
  const normalized = raw.toLowerCase();
  let operation = 'list-invoices';

  if (
    /(income statement|p&l|profit and loss|guv|bwa|revenue.*quarter|umsatz)/u.test(
      normalized,
    )
  ) {
    operation = 'income-statement';
  } else if (
    /(match|reconcile|zuordnen).*(transaction|bank|zahlung|invoice|rechnung)/u.test(
      normalized,
    )
  ) {
    operation = 'match-transaction';
  } else if (
    /(bank transaction|banking transaction|kontoumsatz|zahlungseingang)/u.test(
      normalized,
    )
  ) {
    operation = 'list-bank-transactions';
  } else if (
    /(payment status|paid status|open amount|outstanding payment|paid off|paidoff)/u.test(
      normalized,
    )
  ) {
    operation = 'payment-status';
  } else if (
    /(create|draft|generate|new).*(invoice|rechnung)/u.test(normalized)
  ) {
    operation = 'create-invoice';
  } else if (
    /(download|file|pdf|xrechnung|zugferd).*(invoice|rechnung)/u.test(
      normalized,
    )
  ) {
    operation = 'invoice-file';
  } else if (
    /(download).*(receipt|beleg|voucher file|file)|receipt file.*(download|get)/u.test(
      normalized,
    )
  ) {
    operation = 'download-file';
  } else if (
    /(receipt|beleg|expense|reisekosten|purchase invoice).*(sync|upload|attach|file|log|create|book|record)/u.test(
      normalized,
    ) ||
    /(sync|upload|attach|file|log|create|book|record).*(receipt|beleg|expense|reisekosten|purchase invoice)/u.test(
      normalized,
    )
  ) {
    operation = /(upload|attach|file)/u.test(normalized)
      ? 'upload-file'
      : 'log-expense';
  } else if (/(category|posting categor|konto|kontierung)/u.test(normalized)) {
    operation = 'posting-categories';
  } else if (
    /(expense|belege|receipts|purchase invoices|reisekosten)/u.test(normalized)
  ) {
    operation = 'list-expenses';
  } else if (/(customer|contact|kunde)/u.test(normalized)) {
    operation = 'list-customers';
  } else if (/(product|article|service|leistung|artikel)/u.test(normalized)) {
    operation = 'list-products';
  } else if (/(profile|organization|company)/u.test(normalized)) {
    operation = 'profile';
  } else if (/(voucher|beleg).*id/u.test(normalized)) {
    operation = 'get-voucher';
  } else if (/(invoice|rechnung).*id/u.test(normalized)) {
    operation = 'get-invoice';
  }

  const mutatesAccount =
    WRITE_OPERATIONS.has(operation) || operation === 'match-transaction';
  return {
    input: raw,
    operation,
    mutatesAccount,
    operatorGrantRequired: mutatesAccount,
    defaultAutonomy: mutatesAccount
      ? 'operator_grant_required'
      : 'read_allowed',
    apiNotes:
      operation === 'list-bank-transactions' ||
      operation === 'match-transaction'
        ? 'Lexware Public API does not expose raw bank-transaction listing or matching writes; use payment-status reads and operator handoff.'
        : undefined,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function loadEvalScenarios() {
  return JSON.parse(fs.readFileSync(EVAL_SCENARIOS_PATH, 'utf8'));
}

function evaluateScenarios() {
  const scenarios = loadEvalScenarios();
  const results = scenarios.map((scenario) => {
    const plan = planLexwareOfficeRequest(scenario.prompt);
    const pass =
      plan.operation === scenario.expected.operation &&
      plan.operatorGrantRequired === scenario.expected.operatorGrantRequired &&
      scenario.costMeasurement?.system === 'UsageTotals';
    return {
      id: scenario.id,
      category: scenario.category,
      pass,
      expected: scenario.expected,
      actual: {
        operation: plan.operation,
        operatorGrantRequired: plan.operatorGrantRequired,
      },
    };
  });
  const failed = results.filter((result) => !result.pass);
  return {
    command: 'eval-scenarios',
    scenarioCount: scenarios.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function commonInput(args) {
  return {
    bearerSecretName:
      args['bearer-secret-name'] ||
      process.env.LEXWARE_OFFICE_BEARER_SECRET_NAME ||
      DEFAULT_BEARER_SECRET_NAME,
    dryRun: Boolean(args['dry-run']),
    operatorGrant: Boolean(args['operator-grant']),
    page: args.page,
    size: args.size,
    traceId: args['trace-id'],
  };
}

function printHelp() {
  process.stdout.write(`Lexware Office skill helper

Usage:
  node skills/lexware-office/lexware_office.cjs plan "natural language request"
  node skills/lexware-office/lexware_office.cjs http-request <operation> [--id ID] [--query-json JSON] [--body-json JSON] [--operator-grant] [--finalize]
  node skills/lexware-office/lexware_office.cjs income-statement-plan --from YYYY-MM-DD --to YYYY-MM-DD
  node skills/lexware-office/lexware_office.cjs aggregate-income-statement --revenue-json JSON --expenses-json JSON [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  node skills/lexware-office/lexware_office.cjs bank-transactions-from-payments --payments-json JSON
  node skills/lexware-office/lexware_office.cjs create-invoice --body-json JSON --operator-grant [--finalize]
  node skills/lexware-office/lexware_office.cjs log-expense --body-json JSON --operator-grant
  node skills/lexware-office/lexware_office.cjs upload-file --file PATH --operator-grant [--type voucher]
  node skills/lexware-office/lexware_office.cjs attach-voucher-file --id VOUCHER_ID --file PATH --operator-grant
  node skills/lexware-office/lexware_office.cjs match-transaction --transaction-id ID --voucher-id ID --operator-grant
  node skills/lexware-office/lexware_office.cjs eval-scenarios

Read operations:
  profile, list-customers, get-customer, list-products, get-product,
  list-invoices, get-invoice, invoice-file, list-expenses, get-voucher,
  download-file, payment-status, posting-categories, income-statement,
  list-bank-transactions

Write operations requiring --operator-grant:
  create-invoice, log-expense, upload-file, attach-voucher-file, match-transaction

Environment:
  LEXWARE_OFFICE_BEARER_SECRET_NAME  Stored secret name, default ${DEFAULT_BEARER_SECRET_NAME}
`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === 'help' || args.help) {
    printHelp();
    return;
  }

  if (command === 'plan') {
    printJson(planLexwareOfficeRequest(args._.slice(1).join(' ')));
    return;
  }

  if (command === 'eval-scenarios') {
    const result = evaluateScenarios();
    printJson(result);
    if (result.failed > 0) process.exitCode = 1;
    return;
  }

  if (command === 'income-statement-plan') {
    printJson(
      buildIncomeStatementPlan({
        ...commonInput(args),
        from: args.from,
        to: args.to,
      }),
    );
    return;
  }

  if (command === 'aggregate-income-statement') {
    printJson(
      aggregateIncomeStatement({
        revenue: resolveJsonInput(args, 'revenue'),
        expenses: resolveJsonInput(args, 'expenses'),
        from: parseIsoDate(args.from, '--from'),
        to: parseIsoDate(args.to, '--to'),
      }),
    );
    return;
  }

  if (command === 'bank-transactions-from-payments') {
    printJson(
      extractBankTransactionsFromPayments({
        payments: resolveJsonInput(args, 'payments'),
        voucherId: args['voucher-id'],
      }),
    );
    return;
  }

  if (command === 'match-transaction') {
    printJson(
      buildTransactionMatchHandoff({
        ...commonInput(args),
        transactionId: args['transaction-id'],
        voucherId: args['voucher-id'],
        invoiceId: args['invoice-id'],
      }),
    );
    return;
  }

  if (command === 'http-request') {
    printJson(
      buildHttpRequest({
        ...commonInput(args),
        operation: args._[1],
        id: args.id,
        query: resolveJsonInput(args, 'query') || {},
        body: resolveJsonInput(args, 'body'),
        finalize: Boolean(args.finalize),
      }),
    );
    return;
  }

  if (
    command === 'create-invoice' ||
    command === 'log-expense' ||
    command === 'upload-file' ||
    command === 'attach-voucher-file'
  ) {
    printJson(
      buildHttpRequest({
        ...commonInput(args),
        operation: command,
        id: args.id,
        body: resolveJsonInput(args, 'body'),
        filePath: args.file,
        filename: args.filename,
        mimeType: args['mime-type'],
        uploadType: args.type,
        finalize: Boolean(args.finalize),
      }),
    );
    return;
  }

  throw new LexwareOfficeConfigError(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    printJson({
      error: {
        name: error.name || 'Error',
        code: error.code || 'LEXWARE_OFFICE_ERROR',
        message: error.message,
        operation: error.operation,
        requiredGrant: error.requiredGrant,
      },
      costMeasurement: usageTotalsMeasurement(),
    });
    process.exitCode = 1;
  });
}

module.exports = {
  API_BASE,
  DEFAULT_BEARER_SECRET_NAME,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  SUPPORTED_OPERATIONS,
  LexwareOfficeConfigError,
  LexwareOfficeOperatorGrantError,
  buildBankTransactionLimitation,
  aggregateIncomeStatement,
  buildHttpRequest,
  buildIncomeStatementPlan,
  buildTransactionMatchHandoff,
  evaluateScenarios,
  extractBankTransactionsFromPayments,
  htmlEncodeSearchValue,
  planLexwareOfficeRequest,
  usageTotalsMeasurement,
};
