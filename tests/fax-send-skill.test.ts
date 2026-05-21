import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { PDFDocument } from 'pdf-lib';
import { expect, test, vi } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'fax-send',
  'fax_send.cjs',
);
const skillPath = path.join(process.cwd(), 'skills', 'fax-send', 'SKILL.md');
const docsPath = path.join(
  process.cwd(),
  'docs',
  'content',
  'channels',
  'fax.md',
);
const require = createRequire(import.meta.url);
const fax = require('../skills/fax-send/fax_send.cjs');

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

function extractMultipartPdf(bodyBase64: string) {
  const body = Buffer.from(bodyBase64, 'base64');
  const start = body.indexOf(Buffer.from('%PDF-1.4', 'utf8'));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = body.indexOf(
    Buffer.from('\r\n------hybridclaw-fax-pdf-boundary', 'utf8'),
    start,
  );
  expect(end).toBeGreaterThan(start);
  return body.subarray(start, end);
}

test('fax-send skill manifest declares DACH fax metadata and guarded secrets', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: fax-send');
  expect(skill).toContain('issue: 659');
  expect(skill).toContain('SINCH_FAX_BASIC_AUTH');
  expect(skill).toContain('SINCH_FAX_OAUTH_TOKEN');
  expect(skill).toContain('SINCH_FAX_PROJECT_ID');
  expect(skill).toContain('fax.send.start');
  expect(skill).toContain('fax.send.delivered');
  expect(skill).toContain('fax.send.failed');
  expect(skill).toContain('recordFaxUsageEvent()');
  expect(skill).toContain('UsageTotals');
  expect(skill).toContain('unit: fax-page');
  expect(skill).toContain('Return exactly one user-facing summary');
  expect(skill).toContain('write the status sentence once');
  expect(skill).toContain('text content such as "Hallo Welt"');
  expect(skill).toContain('A live `http_request` to Sinch is terminal');
  expect(skill).toContain('Do not use `web_search`');
  expect(skill).toContain('helper-generated PDF upload');
  expect(skill).toContain('give one concise no-send summary only');
  expect(skill).toContain('do not add decorative emoji');
});

test('fax-send helper builds Sinch send request with secret-backed Basic auth', () => {
  const payload = fax.buildSendRequest({
    provider: 'sinch',
    auth: 'basic',
    projectId: 'project-123',
    serviceId: 'service-123',
    contentUrl: 'https://example.com/contract.pdf',
    to: '+49 89 1234567',
    from: '+49 30 12345678',
    pageCount: 3,
    labels: ['costCenter=legal'],
    operatorGrant: true,
    timeoutMs: 120000,
    maxResponseBytes: 1000000,
    headerPageNumbers: true,
  });

  expect(payload.operation).toBe('fax.send');
  expect(payload.stakesTier).toBe('amber');
  expect(payload.httpRequest).toMatchObject({
    url: 'https://fax.api.sinch.com/v3/projects/project-123/faxes',
    method: 'POST',
    skillName: 'fax-send',
    stakesTier: 'amber',
    secretHeaders: [
      {
        name: 'Authorization',
        secretName: 'SINCH_FAX_BASIC_AUTH',
        prefix: 'Basic',
      },
    ],
    json: {
      to: '+49891234567',
      from: '+493012345678',
      contentUrl: ['https://example.com/contract.pdf'],
      serviceId: 'service-123',
      labels: { costCenter: 'legal' },
    },
  });
  expect(payload.costMeasurement).toEqual({
    system: 'UsageTotals',
    subLimitKey: 'fax-pages',
    unit: 'fax-page',
    pageCount: 3,
  });
  expect(payload.liveExecution.requiresOneOfConfiguredSecrets).toEqual([
    'SINCH_FAX_BASIC_AUTH',
    'SINCH_FAX_OAUTH_TOKEN',
  ]);
  expect(payload.liveExecution.requiresConfiguredSecrets).toEqual([
    'SINCH_FAX_PROJECT_ID',
  ]);
  expect(payload.liveExecution.callPolicy).toContain(
    'summarize the provider result once',
  );
  expect(payload.liveExecution.requestShape).toContain(
    'helper-generated PDF multipart upload',
  );
  expect(payload.liveExecution.terminalProviderResponsePolicy).toContain(
    'do not duplicate the status sentence',
  );
  expect(payload.liveExecution.terminalProviderResponsePolicy).toContain(
    'ask to retry',
  );
  expect(payload.auditEvents[0]).toMatchObject({
    eventType: 'fax.send.start',
    payload: {
      provider: 'sinch',
      to: '+49891234567',
      from: '+493012345678',
      pageCount: 3,
    },
  });
  expect(JSON.stringify(payload)).not.toContain('username:password');
});

test('fax-send helper uses stored Sinch project and default sender for text uploads', () => {
  const payload = fax.buildSendRequest({
    provider: 'sinch',
    auth: 'basic',
    text: 'Hallo Welt',
    filename: 'hallo-welt.pdf',
    to: '+498920931098',
    labels: [],
    operatorGrant: true,
    timeoutMs: 120000,
    maxResponseBytes: 1000000,
    headerPageNumbers: true,
  });

  expect(payload.httpRequest.url).toBe(
    'https://fax.api.sinch.com/v3/projects/<secret:SINCH_FAX_PROJECT_ID>/faxes',
  );
  const body = Buffer.from(payload.httpRequest.bodyBase64, 'base64').toString(
    'utf8',
  );
  expect(body).not.toContain('name="from"');
  expect(body).toContain('+498920931098');
  expect(payload.auditEvents[0]).toMatchObject({
    eventType: 'fax.send.start',
    payload: {
      provider: 'sinch',
      to: '+498920931098',
    },
  });
  expect(payload.auditEvents[0].payload).not.toHaveProperty('from');
  expect(payload.liveExecution.requiresConfiguredSecrets).toEqual([
    'SINCH_FAX_PROJECT_ID',
  ]);
});

test('fax-send helper can use an explicit Sinch service id', () => {
  const payload = fax.buildSendRequest({
    provider: 'sinch',
    auth: 'basic',
    text: 'Hallo Welt',
    filename: 'hallo-welt.pdf',
    to: '+498920931098',
    from: '+493012345678',
    serviceId: 'service-123',
    labels: [],
    operatorGrant: true,
    timeoutMs: 120000,
    maxResponseBytes: 1000000,
    headerPageNumbers: true,
  });

  const body = Buffer.from(payload.httpRequest.bodyBase64, 'base64').toString(
    'utf8',
  );
  expect(body).toContain('name="serviceId"');
  expect(body).toContain('service-123');
});

test('fax-send helper supports bearer auth for Sinch OAuth deployments', () => {
  const payload = fax.buildStatusRequest({
    provider: 'sinch',
    auth: 'bearer',
    faxId: '01F3J0G1M4WQR6HGY6HCF6JA0K',
    timeoutMs: 120000,
    maxResponseBytes: 1000000,
  });

  expect(payload.operation).toBe('fax.status');
  expect(payload.stakesTier).toBe('green');
  expect(payload.httpRequest).toMatchObject({
    url: 'https://fax.api.sinch.com/v3/projects/<secret:SINCH_FAX_PROJECT_ID>/faxes/01F3J0G1M4WQR6HGY6HCF6JA0K',
    method: 'GET',
    bearerSecretName: 'SINCH_FAX_OAUTH_TOKEN',
  });
});

test('fax-send refuses live sends without an operator grant', () => {
  expect(() =>
    fax.buildSendRequest({
      provider: 'sinch',
      auth: 'basic',
      projectId: 'project-123',
      pdfUrl: 'https://example.com/contract.pdf',
      to: '+49891234567',
      from: '+493012345678',
      labels: [],
      timeoutMs: 120000,
      maxResponseBytes: 1000000,
    }),
  ).toThrow(/operator approval/);
});

test('fax-send accepts supported content URLs and rejects unsafe URLs', () => {
  const base = {
    provider: 'sinch',
    auth: 'basic',
    projectId: 'project-123',
    to: '+49891234567',
    from: '+493012345678',
    labels: [],
    operatorGrant: true,
    timeoutMs: 120000,
    maxResponseBytes: 1000000,
  };

  expect(() =>
    fax.buildSendRequest({
      ...base,
      contentUrl: 'ftp://example.com/contract.pdf',
    }),
  ).toThrow(/http or https/);
  expect(() =>
    fax.buildSendRequest({
      ...base,
      contentUrl: 'https://user:pass@example.com/contract.pdf',
    }),
  ).toThrow(/embedded credentials/);

  const payload = fax.buildSendRequest({
    ...base,
    contentUrl: 'https://example.com/hello.html',
  });

  expect(payload.httpRequest.json.contentUrl).toEqual([
    'https://example.com/hello.html',
  ]);
  expect(payload.httpRequest.skillRequestContract.documentKind).toBe(
    'content-url',
  );
});

test('fax-send helper renders direct text input into a valid PDF upload', async () => {
  const payload = fax.buildSendRequest({
    provider: 'sinch',
    auth: 'basic',
    projectId: 'project-123',
    serviceId: 'service-123',
    text: 'Hallo Welt',
    filename: 'hallo-welt.txt',
    to: '+498920931098',
    from: '+493012345678',
    labels: ['costCenter=test'],
    operatorGrant: true,
    timeoutMs: 120000,
    maxResponseBytes: 1000000,
    headerPageNumbers: true,
  });

  expect(payload.httpRequest.headers).toMatchObject({
    'Content-Type':
      'multipart/form-data; boundary=----hybridclaw-fax-pdf-boundary',
  });
  const body = Buffer.from(payload.httpRequest.bodyBase64, 'base64').toString(
    'utf8',
  );
  expect(body).toContain('name="file"; filename="hallo-welt.pdf"');
  expect(body).toContain('Content-Type: application/pdf');
  expect(body).toContain('Hallo Welt');
  expect(body).toContain('name="to"');
  expect(body).toContain('+498920931098');
  const pdfBytes = extractMultipartPdf(payload.httpRequest.bodyBase64);
  const pdf = await PDFDocument.load(pdfBytes);
  expect(pdf.getPageCount()).toBe(1);
  expect(payload.httpRequest.skillRequestContract.documentKind).toBe('pdf');
});

test('fax-send classifies delivered and busy-line failed statuses for audit', () => {
  const delivered = fax.classifyStatus({
    provider: 'sinch',
    faxId: 'fax-123',
    status: 'COMPLETED',
    pagesSent: 2,
  });
  const failed = fax.classifyStatus({
    provider: 'sinch',
    faxId: 'fax-123',
    status: 'FAILURE',
    errorType: 'CALL_ERROR',
    errorMessage: 'Line busy',
  });

  expect(delivered.auditEvents[0].eventType).toBe('fax.send.delivered');
  expect(delivered.retryRecommended).toBe(false);
  expect(failed.auditEvents[0].eventType).toBe('fax.send.failed');
  expect(failed.retryRecommended).toBe(true);
});

test('sendFax returns a provider fax id when dispatched through a gateway adapter', async () => {
  const faxId = await fax.sendFax(
    'https://example.com/contract.pdf',
    '+49891234567',
    {
      provider: 'sinch',
      auth: 'basic',
      projectId: 'project-123',
      from: '+493012345678',
      labels: [],
      operatorGrant: true,
      timeoutMs: 120000,
      maxResponseBytes: 1000000,
      dispatch: async (httpRequest: unknown) => {
        expect(httpRequest).toMatchObject({
          method: 'POST',
          skillName: 'fax-send',
        });
        return { body: JSON.stringify({ id: 'fax-provider-123' }) };
      },
    },
  );

  expect(faxId).toBe('fax-provider-123');
});

test('fax-send helper exposes at least 15 eval scenarios', () => {
  const result = runHelper(['--format', 'json', 'eval-scenarios']);

  expect(result.status).toBe(0);
  const scenarios = JSON.parse(result.stdout);
  expect(scenarios).toHaveLength(15);
  expect(
    scenarios.some(
      (scenario: { expectedOperation?: string; expectedDownstream?: string }) =>
        scenario.expectedOperation === 'fax.inbound.email-route' &&
        scenario.expectedDownstream === 'DATEV Belegtransfer',
    ),
  ).toBe(true);
  expect(
    scenarios.every(
      (scenario: { costMeasurement?: { system?: string; unit?: string } }) =>
        scenario.costMeasurement?.system === 'UsageTotals' &&
        scenario.costMeasurement?.unit === 'fax-page',
    ),
  ).toBe(true);
});

test('fax-send helper lists Sinch EU as the implemented provider reference', () => {
  const result = runHelper(['--format', 'json', 'providers']);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.providers).toContainEqual(
    expect.objectContaining({
      id: 'sinch-eu',
      provider: 'sinch',
      residency: 'eu',
      implemented: true,
    }),
  );
  expect(payload.providers).toContainEqual(
    expect.objectContaining({
      id: 'telekom-cloud-fax',
      residency: 'de',
      implemented: false,
    }),
  );
});

test('fax channel docs describe fax-to-email inbound wiring and retention', () => {
  const docs = fs.readFileSync(docsPath, 'utf-8');

  expect(docs).toContain('fax-to-email');
  expect(docs).toContain('hybridclaw channels email setup');
  expect(docs).toContain('DATEV Belegtransfer');
  expect(docs).toContain('fax.send.start');
  expect(docs).toContain('Sinch Fax');
  expect(docs).toContain('EU-region');
  expect(docs).toContain('UsageTotals.billable_units');
  expect(docs).toContain('delivery receipt');
  expect(docs).toContain('qualified electronic');
  expect(docs).toContain('+19898989898');
});

test('fax accounting persists structured audit events and page usage totals', async () => {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-fax-accounting-')),
    'test.db',
  );
  vi.resetModules();
  const {
    getRecentStructuredAuditForSession,
    getUsageBillableUnitTotals,
    getUsageTotals,
    initDatabase,
  } = await import('../src/memory/db.ts');
  const {
    recordFaxSendDelivered,
    recordFaxSendFailed,
    recordFaxSendStart,
    recordFaxUsageEvent,
  } = await import('../src/fax/accounting.ts');

  initDatabase({ quiet: true, dbPath });
  const runId = recordFaxSendStart({
    sessionId: 'session-fax',
    provider: 'sinch',
    recipientNumber: '+49891234567',
    senderNumber: '+493012345678',
    pageCount: 3,
    documentUrl: 'https://example.com/contract.pdf',
  });
  recordFaxSendDelivered({
    sessionId: 'session-fax',
    runId,
    provider: 'sinch',
    providerMessageId: 'fax-provider-123',
    recipientNumber: '+49891234567',
    senderNumber: '+493012345678',
    pageCount: 3,
  });
  recordFaxSendFailed({
    sessionId: 'session-fax',
    runId,
    provider: 'sinch',
    providerMessageId: 'fax-provider-456',
    recipientNumber: '+49891234567',
    pageCount: 3,
    errorType: 'CALL_ERROR',
    errorMessage: 'Line busy',
    retryable: true,
  });
  recordFaxUsageEvent({
    sessionId: 'session-fax',
    agentId: 'agent-fax',
    provider: 'sinch',
    pageCount: 3,
    costUsd: 0.45,
  });

  const audit = getRecentStructuredAuditForSession('session-fax', 10);
  expect(audit.map((event) => event.event_type)).toEqual([
    'fax.send.failed',
    'fax.send.delivered',
    'fax.send.start',
  ]);
  expect(JSON.parse(audit[0]?.payload || '{}')).toMatchObject({
    type: 'fax.send.failed',
    provider: 'sinch',
    providerMessageId: 'fax-provider-456',
    retryable: true,
  });

  const totals = getUsageTotals({ agentId: 'agent-fax', window: 'daily' });
  expect(totals.total_cost_usd).toBeCloseTo(0.45, 6);
  expect(totals.billable_units).toEqual([
    { unit: 'fax-page', quantity: 3, cost_usd: 0.45 },
  ]);
  expect(getUsageBillableUnitTotals({ agentId: 'agent-fax' })).toEqual([
    { unit: 'fax-page', quantity: 3, cost_usd: 0.45 },
  ]);
});
