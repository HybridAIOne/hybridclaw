import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'lexware-office',
  'lexware_office.cjs',
);
const skillPath = path.join(
  process.cwd(),
  'skills',
  'lexware-office',
  'SKILL.md',
);
const scenariosPath = path.join(
  process.cwd(),
  'skills',
  'lexware-office',
  'evals',
  'scenarios.json',
);
const docsPath = path.join(
  process.cwd(),
  'skills',
  'lexware-office',
  'references',
  'operator-setup.md',
);

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('Lexware Office skill manifest declares accounting category and safety metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: lexware-office');
  expect(skill).toContain('category: accounting');
  expect(skill).toContain('LEXWARE_OFFICE_API_KEY');
  expect(skill).toContain('https://api.lexware.io');
  expect(skill).toContain('stakes_tiers:');
  expect(skill).toContain('transaction-match-plan');
  expect(skill).toContain('UsageTotals');
});

test('Lexware Office operator docs cover key creation and routing', () => {
  const docs = fs.readFileSync(docsPath, 'utf-8');

  expect(docs).toContain('https://app.lexware.de/addons/public-api');
  expect(docs).toContain('hybridclaw secret set LEXWARE_OFFICE_API_KEY');
  expect(docs).toContain('secret route add https://api.lexware.io/');
  expect(docs).toContain('2 requests per second');
  expect(docs).toContain('incoming bank transaction');
});

test('Lexware Office helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Lexware Office skill helper');
  expect(result.stdout).toContain('list-contacts');
  expect(result.stdout).toContain('list-invoices');
  expect(result.stdout).toContain('log-expense');
  expect(result.stdout).toContain('income-statement-plan');
  expect(result.stdout).toContain('income-statement');
  expect(result.stdout).toContain('match-transaction');
  expect(result.stdout).toContain('eval-scenarios');
});

test('Lexware Office helper plans reads, writes, reports, and transaction matching', () => {
  const invoiceRead = runHelper([
    '--format',
    'json',
    'plan',
    'Show open invoices in Lexware Office',
  ]);
  const invoiceWrite = runHelper([
    '--format',
    'json',
    'plan',
    'Generate an invoice for Acme GmbH',
  ]);
  const report = runHelper([
    '--format',
    'json',
    'plan',
    'Export the Q4 income statement',
  ]);
  const transactionMatch = runHelper([
    '--format',
    'json',
    'plan',
    'Match the incoming bank transaction with the open invoice',
  ]);

  expect(JSON.parse(invoiceRead.stdout)).toMatchObject({
    operation: 'list-invoices',
    requiresEscalation: false,
  });
  expect(JSON.parse(invoiceWrite.stdout)).toMatchObject({
    operation: 'create-invoice',
    stakesTier: 'amber',
    requiredGrant: 'approve-lexware-office-create-invoice',
  });
  expect(JSON.parse(report.stdout)).toMatchObject({
    operation: 'income-statement-plan',
    requiresEscalation: false,
  });
  expect(JSON.parse(transactionMatch.stdout)).toMatchObject({
    operation: 'match-transaction',
    executable: true,
    requiredGrant: 'approve-lexware-office-transaction-match',
  });
});

test('Lexware Office helper emits gateway-proxied read requests without secrets', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'list-invoices',
    '--status',
    'open',
    '--size',
    '50',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'GET',
    bearerSecretName: 'LEXWARE_OFFICE_API_KEY',
    skillName: 'lexware-office',
  });
  expect(payload.httpRequest.url).toContain(
    'https://api.lexware.io/v1/voucherlist?',
  );
  expect(payload.httpRequest.url).toContain('voucherType=invoice');
  expect(payload.httpRequest.url).toContain('voucherStatus=open');
  expect(payload.httpRequest.url).toContain('size=50');
  expect(result.stdout).not.toContain('api-key');
  expect(payload.costMeasurement.system).toBe('UsageTotals');
});

test('Lexware Office helper builds income statement read sequence', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'income-statement-plan',
    '--start-date',
    '2026-10-01',
    '--end-date',
    '2026-12-31',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.command).toBe('income-statement-plan');
  expect(payload.requestSequence).toHaveLength(3);
  expect(payload.requestSequence[0].url).toContain('/v1/voucherlist?');
  expect(payload.requestSequence[1].url).toContain('/v1/voucherlist?');
  expect(payload.requestSequence[2].url).toBe(
    'https://api.lexware.io/v1/posting-categories',
  );
  expect(payload.costMeasurement.system).toBe('UsageTotals');
});

test('Lexware Office helper builds bank transaction read workflow', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'list-bank-transactions',
    '--status',
    'paid',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.command).toBe('bank-transaction-plan');
  expect(payload.requestSequence[0]).toMatchObject({
    method: 'GET',
    bearerSecretName: 'LEXWARE_OFFICE_API_KEY',
  });
  expect(payload.requestSequence[0].url).toContain('/v1/voucherlist?');
  expect(payload.followUpRequestTemplate.url).toBe(
    'https://api.lexware.io/v1/payments/{voucherId}',
  );
  expect(payload.filterPaymentItemType).toBe('partPaymentFinancialTransaction');
});

test('Lexware Office helper aggregates income statements from fetched voucher pages', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexware-office-'));
  const revenuePath = path.join(tempDir, 'revenue.json');
  const expensePath = path.join(tempDir, 'expenses.json');
  fs.writeFileSync(
    revenuePath,
    JSON.stringify({
      content: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          voucherType: 'invoice',
          totalAmount: 1000,
          voucherItems: [{ amount: 1000, categoryId: 'sales' }],
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          voucherType: 'creditnote',
          totalAmount: 100,
        },
      ],
    }),
  );
  fs.writeFileSync(
    expensePath,
    JSON.stringify({
      content: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          voucherType: 'purchaseinvoice',
          totalAmount: 250,
          voucherItems: [{ amount: 250, categoryId: 'travel' }],
        },
      ],
    }),
  );

  const result = runHelper([
    '--format',
    'json',
    'income-statement',
    '--revenue-file',
    revenuePath,
    '--expense-file',
    expensePath,
    '--start-date',
    '2026-10-01',
    '--end-date',
    '2026-12-31',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'income-statement',
    currency: 'EUR',
    totals: {
      revenue: 900,
      expenses: 250,
      netIncome: 650,
    },
    counts: {
      revenueVouchers: 2,
      expenseVouchers: 1,
    },
  });
  expect(payload.categoryBreakdown.expenses.travel).toBe(250);
});

test('Lexware Office helper requires grants for writes', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'create-invoice',
    '--json',
    '{"voucherDate":"2026-05-21T00:00:00.000+02:00"}',
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    'Refusing Lexware Office write without --operator-grant',
  );
});

test('Lexware Office helper emits invoice write request after grant', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'create-invoice',
    '--json',
    '{"voucherDate":"2026-05-21T00:00:00.000+02:00"}',
    '--finalize',
    '--operator-grant',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.lexware.io/v1/invoices?finalize=true',
    bearerSecretName: 'LEXWARE_OFFICE_API_KEY',
  });
  expect(payload.httpRequest.json).toEqual({
    voucherDate: '2026-05-21T00:00:00.000+02:00',
  });
});

test('Lexware Office helper validates UUIDs and page size bounds', () => {
  const badUuid = runHelper([
    '--format',
    'json',
    'http-request',
    'get-invoice',
    '--id',
    'not-a-uuid',
  ]);
  const badSize = runHelper([
    '--format',
    'json',
    'http-request',
    'list-contacts',
    '--size',
    '251',
  ]);

  expect(badUuid.status).not.toBe(0);
  expect(badUuid.stderr).toContain('--id must be a UUID.');
  expect(badSize.status).not.toBe(0);
  expect(badSize.stderr).toContain('--size must be between 1 and 250.');
});

test('Lexware Office helper matches bank transactions against open invoices', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexware-office-'));
  const invoicesPath = path.join(tempDir, 'invoices.json');
  fs.writeFileSync(
    invoicesPath,
    JSON.stringify({
      content: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          voucherNumber: '2026-042',
          contactName: 'Acme GmbH',
          openAmount: 119,
        },
      ],
    }),
  );

  const result = runHelper([
    '--format',
    'json',
    'match-transaction',
    '--transaction-json',
    '{"id":"tx-1","amount":119,"purpose":"Payment invoice 2026-042 Acme GmbH"}',
    '--invoices-file',
    invoicesPath,
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'match-transaction',
    matched: true,
    writeOperation: 'http-request match-transaction',
  });
  expect(payload.bestMatch).toMatchObject({
    voucherId: '11111111-1111-4111-8111-111111111111',
    score: 1,
  });
});

test('Lexware Office helper emits granted transaction-match voucher annotation request', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'match-transaction',
    '--voucher-id',
    '11111111-1111-4111-8111-111111111111',
    '--voucher-json',
    '{"id":"11111111-1111-4111-8111-111111111111","type":"salesinvoice","voucherNumber":"2026-042","version":3,"remark":"Original"}',
    '--transaction-json',
    '{"id":"tx-1","amount":119,"bookingDate":"2026-05-21","counterpartyName":"Acme GmbH"}',
    '--operator-grant',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'PUT',
    url: 'https://api.lexware.io/v1/vouchers/11111111-1111-4111-8111-111111111111',
    bearerSecretName: 'LEXWARE_OFFICE_API_KEY',
  });
  expect(payload.httpRequest.json).not.toHaveProperty('id');
  expect(payload.httpRequest.json).toMatchObject({
    type: 'salesinvoice',
    voucherNumber: '2026-042',
    version: 3,
  });
  expect(payload.httpRequest.json.remark).toContain(
    'HybridClaw bank match: transaction tx-1',
  );
});

test('Lexware Office helper builds multipart receipt uploads', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexware-office-'));
  const receiptPath = path.join(tempDir, 'receipt.pdf');
  fs.writeFileSync(receiptPath, 'pdf-bytes');

  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'upload-file',
    '--file',
    receiptPath,
    '--operator-grant',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.lexware.io/v1/files',
    bearerSecretName: 'LEXWARE_OFFICE_API_KEY',
  });
  expect(payload.httpRequest.headers['Content-Type']).toContain(
    'multipart/form-data',
  );
  expect(payload.httpRequest.bodyBase64).toBeTypeOf('string');
});

test('Lexware Office helper eval suite covers roadmap behaviors', () => {
  const scenarios = JSON.parse(
    fs.readFileSync(scenariosPath, 'utf-8'),
  ) as Array<{ category?: string; expected?: { costSystem?: string } }>;
  const categories = new Set(scenarios.map((scenario) => scenario.category));

  expect(scenarios.length).toBeGreaterThanOrEqual(25);
  expect(scenarios.length).toBeLessThanOrEqual(30);
  expect(categories).toEqual(
    new Set([
      'invoice_read',
      'invoice_write',
      'customer_read',
      'customer_write',
      'product_read',
      'expense_read',
      'expense_write',
      'payment_read',
      'payment_write',
      'accounting_read',
      'report_read',
      'profile_read',
    ]),
  );
  expect(
    scenarios.every(
      (scenario) => scenario.expected?.costSystem === 'UsageTotals',
    ),
  ).toBe(true);

  const result = runHelper(['--format', 'json', 'eval-scenarios']);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.scenarioCount).toBe(scenarios.length);
  expect(payload.failed).toBe(0);
  expect(payload.costMeasurement.system).toBe('UsageTotals');
});
