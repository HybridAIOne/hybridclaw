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

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('Lexware Office skill manifest declares accounting scope and secret handling', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: lexware-office');
  expect(skill).toContain('category: accounting');
  expect(skill).toContain('LEXWARE_OFFICE_API_KEY');
  expect(skill).toContain('https://app.lexware.de/addons/public-api');
  expect(skill).toContain('https://api.lexware.io/v1');
  expect(skill).toContain('create-invoice');
  expect(skill).toContain('log-expense');
  expect(skill).toContain('match-transaction');
  expect(skill).toContain('UsageTotals');
});

test('Lexware Office helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Lexware Office skill helper');
  expect(result.stdout).toContain('http-request <operation>');
  expect(result.stdout).toContain('income-statement-plan');
  expect(result.stdout).toContain('eval-scenarios');
});

test('Lexware Office helper plans reads, guarded writes, and API limitations', () => {
  const invoices = runHelper([
    'plan',
    'Pull outstanding invoices older than 30 days',
  ]);
  const createInvoice = runHelper([
    'plan',
    'Generate an invoice for Acme GmbH for consulting',
  ]);
  const receipt = runHelper([
    'plan',
    'Sync this expense receipt with category Reisekosten',
  ]);
  const bankTransactions = runHelper([
    'plan',
    'Show incoming bank transaction status for this invoice',
  ]);
  const match = runHelper([
    'plan',
    'Match incoming bank transaction with the open invoice',
  ]);
  const upload = runHelper(['plan', 'Upload this receipt file to Lexware']);

  expect(invoices.status).toBe(0);
  expect(createInvoice.status).toBe(0);
  expect(receipt.status).toBe(0);
  expect(bankTransactions.status).toBe(0);
  expect(match.status).toBe(0);
  expect(upload.status).toBe(0);
  expect(JSON.parse(invoices.stdout)).toMatchObject({
    operation: 'list-invoices',
    operatorGrantRequired: false,
  });
  expect(JSON.parse(createInvoice.stdout)).toMatchObject({
    operation: 'create-invoice',
    operatorGrantRequired: true,
  });
  expect(JSON.parse(receipt.stdout)).toMatchObject({
    operation: 'log-expense',
    operatorGrantRequired: true,
  });
  expect(JSON.parse(bankTransactions.stdout)).toMatchObject({
    operation: 'list-bank-transactions',
    operatorGrantRequired: false,
  });
  expect(JSON.parse(match.stdout)).toMatchObject({
    operation: 'match-transaction',
    operatorGrantRequired: true,
  });
  expect(JSON.parse(upload.stdout)).toMatchObject({
    operation: 'upload-file',
    operatorGrantRequired: true,
  });
});

test('Lexware Office helper builds bearer-secret http_request payloads', () => {
  const result = runHelper([
    'http-request',
    'list-invoices',
    '--query-json',
    '{"voucherStatus":"open","voucherNumber":"ACME & Partner"}',
    '--size',
    '25',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    operation: 'list-invoices',
    mutatesAccount: false,
    httpRequest: {
      method: 'GET',
      bearerSecretName: 'LEXWARE_OFFICE_API_KEY',
      skillName: 'lexware-office',
    },
    costMeasurement: { system: 'UsageTotals' },
  });
  expect(payload.httpRequest.url).toContain(
    'https://api.lexware.io/v1/voucherlist?',
  );
  expect(payload.httpRequest.url).toContain('voucherStatus=open');
  expect(payload.httpRequest.url).toContain(
    'voucherNumber=ACME+%26amp%3B+Partner',
  );
  expect(payload.httpRequest.url).toContain('size=25');
});

test('Lexware Office helper builds bookkeeping file download requests', () => {
  const result = runHelper([
    'http-request',
    'download-file',
    '--id',
    'file-123',
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    operation: 'download-file',
    mutatesAccount: false,
    httpRequest: {
      method: 'GET',
      url: 'https://api.lexware.io/v1/files/file-123',
      headers: {
        Accept: '*/*',
      },
      bearerSecretName: 'LEXWARE_OFFICE_API_KEY',
    },
  });
});

test('Lexware Office helper refuses writes without operator grant', () => {
  const denied = runHelper([
    'create-invoice',
    '--body-json',
    '{"voucherDate":"2026-05-21T00:00:00.000+02:00"}',
  ]);
  const granted = runHelper([
    'create-invoice',
    '--body-json',
    '{"voucherDate":"2026-05-21T00:00:00.000+02:00"}',
    '--operator-grant',
    '--finalize',
  ]);

  expect(denied.status).toBe(1);
  expect(JSON.parse(denied.stdout).error).toMatchObject({
    code: 'LEXWARE_OFFICE_OPERATOR_GRANT_REQUIRED',
    requiredGrant: 'approve-lexware-office-invoice-create',
  });
  expect(granted.status).toBe(0);
  const payload = JSON.parse(granted.stdout);
  expect(payload).toMatchObject({
    operation: 'create-invoice',
    mutatesAccount: true,
    requiredGrant: 'approve-lexware-office-invoice-create',
    httpRequest: {
      method: 'POST',
      json: { voucherDate: '2026-05-21T00:00:00.000+02:00' },
    },
  });
  expect(payload.httpRequest.url).toContain('/invoices?finalize=true');
});

test('Lexware Office helper builds multipart receipt upload requests', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexware-office-'));
  const filePath = path.join(tempDir, 'receipt.pdf');
  fs.writeFileSync(filePath, Buffer.from('%PDF-1.7\n'));

  const denied = runHelper(['upload-file', '--file', filePath]);
  const upload = runHelper([
    'upload-file',
    '--file',
    filePath,
    '--operator-grant',
  ]);
  const attach = runHelper([
    'attach-voucher-file',
    '--id',
    'voucher-123',
    '--file',
    filePath,
    '--operator-grant',
  ]);

  expect(denied.status).toBe(1);
  expect(JSON.parse(denied.stdout).error).toMatchObject({
    code: 'LEXWARE_OFFICE_OPERATOR_GRANT_REQUIRED',
    requiredGrant: 'approve-lexware-office-file-upload',
  });
  expect(upload.status).toBe(0);
  const uploadPayload = JSON.parse(upload.stdout);
  expect(uploadPayload).toMatchObject({
    operation: 'upload-file',
    mutatesAccount: true,
    requiredGrant: 'approve-lexware-office-file-upload',
    httpRequest: {
      method: 'POST',
      url: 'https://api.lexware.io/v1/files',
      bearerSecretName: 'LEXWARE_OFFICE_API_KEY',
    },
  });
  expect(uploadPayload.httpRequest.headers['Content-Type']).toContain(
    'multipart/form-data; boundary=',
  );
  expect(uploadPayload.httpRequest.bodyBase64).toEqual(expect.any(String));

  expect(attach.status).toBe(0);
  expect(JSON.parse(attach.stdout)).toMatchObject({
    operation: 'attach-voucher-file',
    requiredGrant: 'approve-lexware-office-voucher-file-attach',
    httpRequest: {
      method: 'POST',
      url: 'https://api.lexware.io/v1/vouchers/voucher-123/files',
    },
  });
});

test('Lexware Office helper returns income-statement source requests and transaction handoff', () => {
  const report = runHelper([
    'income-statement-plan',
    '--from',
    '2026-10-01',
    '--to',
    '2026-12-31',
  ]);
  const handoff = runHelper([
    'match-transaction',
    '--transaction-id',
    'txn-123',
    '--voucher-id',
    'voucher-456',
    '--operator-grant',
  ]);

  expect(report.status).toBe(0);
  const reportPayload = JSON.parse(report.stdout);
  expect(reportPayload).toMatchObject({
    operation: 'income-statement',
    mutatesAccount: false,
    costMeasurement: { system: 'UsageTotals' },
  });
  expect(reportPayload.sourceRequests).toHaveLength(2);
  expect(reportPayload.sourceRequests[0].url).toContain('/voucherlist?');
  expect(reportPayload.sourceRequests[0].url).toContain(
    'voucherDateFrom=2026-10-01',
  );
  expect(reportPayload.sourceRequests[1].url).toContain(
    'purchaseinvoice%2Cpurchasecreditnote',
  );

  expect(handoff.status).toBe(0);
  expect(JSON.parse(handoff.stdout)).toMatchObject({
    operation: 'match-transaction',
    mutatesAccount: true,
    requiredGrant: 'approve-lexware-office-transaction-match',
    manualHandoff: {
      transactionId: 'txn-123',
      voucherId: 'voucher-456',
    },
    costMeasurement: { system: 'UsageTotals' },
  });
});

test('Lexware Office helper aggregates income statements and extracts bank transactions', () => {
  const statement = runHelper([
    'aggregate-income-statement',
    '--revenue-json',
    '{"content":[{"voucherType":"invoice","totalAmount":1190},{"voucherType":"salescreditnote","totalAmount":190}]}',
    '--expenses-json',
    '{"content":[{"voucherType":"purchaseinvoice","totalAmount":357}]}',
    '--from',
    '2026-01-01',
    '--to',
    '2026-03-31',
  ]);
  const bankTransactions = runHelper([
    'bank-transactions-from-payments',
    '--payments-json',
    '{"id":"voucher-123","voucherType":"invoice","paymentItems":[{"paymentItemType":"partPaymentFinancialTransaction","postingDate":"2026-03-15T00:00:00.000+01:00","amount":1190,"currency":"EUR"},{"paymentItemType":"manualPayment","amount":10,"currency":"EUR"}]}',
  ]);

  expect(statement.status).toBe(0);
  expect(JSON.parse(statement.stdout)).toMatchObject({
    operation: 'income-statement',
    totals: {
      revenue: 1000,
      expenses: 357,
      netIncome: 643,
      currency: 'EUR',
    },
    sourceCounts: {
      revenueVouchers: 2,
      expenseVouchers: 1,
    },
  });

  expect(bankTransactions.status).toBe(0);
  expect(JSON.parse(bankTransactions.stdout)).toMatchObject({
    operation: 'list-bank-transactions',
    transactionCount: 1,
    transactions: [
      {
        voucherId: 'voucher-123',
        paymentItemType: 'partPaymentFinancialTransaction',
        amount: 1190,
        currency: 'EUR',
      },
    ],
  });
});

test('Lexware Office bundled eval suite covers representative accounting requests', () => {
  const scenarios = JSON.parse(fs.readFileSync(scenariosPath, 'utf-8'));
  const result = runHelper(['eval-scenarios']);

  expect(scenarios).toHaveLength(30);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'eval-scenarios',
    scenarioCount: 30,
    failed: 0,
    costMeasurement: { system: 'UsageTotals' },
  });
  expect(payload.results.every((entry: { pass: boolean }) => entry.pass)).toBe(
    true,
  );
});
