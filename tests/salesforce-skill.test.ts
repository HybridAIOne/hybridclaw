import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'salesforce',
  'scripts',
  'salesforce_query.py',
);
const scenariosPath = path.join(
  process.cwd(),
  'skills',
  'salesforce',
  'evals',
  'scenarios.json',
);
const assertionsPath = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'salesforce_helper_assertions.py',
);

function runAssertion(caseName: string) {
  return spawnSync('python3', [assertionsPath, helperPath, caseName], {
    encoding: 'utf-8',
  });
}

test('salesforce helper --help exits cleanly', () => {
  const result = spawnSync('python3', [helperPath, '--help'], {
    encoding: 'utf-8',
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Salesforce CRM schema');
  expect(result.stdout).toContain('--gateway-url');
  expect(result.stdout).toContain('--gateway-token');
  expect(result.stdout).toContain('update-opportunity');
  expect(result.stdout).toContain('log-activity');
  expect(result.stdout).toContain('eval-scenarios');
});

test('salesforce helper plans compound natural-language workflows offline', () => {
  const result = spawnSync(
    'python3',
    [
      helperPath,
      '--format',
      'json',
      'plan',
      'Move the Acme deal to Closed Won and log a call from today',
    ],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.command).toBe('plan');
  expect(payload.costMeasurement.system).toBe('UsageTotals');
  expect(payload.actions).toEqual([
    expect.objectContaining({
      action: 'update-opportunity',
      opportunity: 'Acme',
      stage: 'Closed Won',
      probability: 100,
    }),
    expect.objectContaining({
      action: 'log-activity',
      activityType: 'call',
      target: 'Acme',
      targetObject: 'Opportunity',
      date: 'today',
    }),
  ]);
});

test('salesforce helper preserves custom stage names and escapes SOQL LIKE wildcards', () => {
  const result = runAssertion('normalize-and-escape');

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toEqual({
    standardStage: 'Closed Won',
    customStage: 'legal review - phase_2',
    literal: "Acme_50%\\'s",
    likeLiteral: "Acme\\_50\\%\\'s",
  });
});

test('salesforce helper validates Salesforce request URLs and reuses resolved opportunity ids', () => {
  const result = runAssertion('request-and-reuse');

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.urls).toEqual([
    '<secret:SF_INSTANCE_URL>/services/data/v61.0/query',
    'https://example.my.salesforce.com/services/data/v61.0/query',
  ]);
  expect(payload.errors).toEqual(['http://stubs', 'services/data/v61.0/query']);
  expect(payload.capturedTargets).toEqual(['006000000000001AAA']);
});

test('salesforce helper validates planned actions before writes and ignores malformed API versions', () => {
  const result = runAssertion('validate-plan-and-versions');

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.latest).toBe('61.0');
  expect(payload.invalidVersionError).toContain('invalid API version payload');
  expect(payload.planError).toContain('missing: openOnly');
  expect(payload.writeCount).toBe(0);
});

test('salesforce helper eval suite covers 30 read and write scenarios', () => {
  const scenarios = JSON.parse(
    fs.readFileSync(scenariosPath, 'utf-8'),
  ) as Array<{
    category?: string;
    costMeasurement?: { system?: string };
  }>;
  const categories = new Set(scenarios.map((scenario) => scenario.category));

  expect(scenarios).toHaveLength(30);
  expect(categories).toEqual(
    new Set(['read', 'write-update', 'write-activity', 'compound']),
  );
  expect(
    scenarios.every(
      (scenario) => scenario.costMeasurement?.system === 'UsageTotals',
    ),
  ).toBe(true);

  const result = spawnSync(
    'python3',
    [helperPath, '--format', 'json', 'eval-scenarios'],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.scenarioCount).toBe(30);
  expect(payload.failed).toBe(0);
  expect(payload.categories).toMatchObject({
    read: 10,
    'write-update': 10,
    'write-activity': 5,
    compound: 5,
  });
});

test('salesforce helper builds gateway-backed opportunity update and activity writes', () => {
  const result = runAssertion('write-payloads');

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.update.update).toEqual({
    StageName: 'Closed Won',
    Probability: 100,
  });
  expect(payload.activity.activityObject).toBe('Task');
  expect(payload.activity.fields).toEqual(
    expect.objectContaining({
      Subject: 'Call: Discovery follow-up',
      Status: 'Completed',
      Priority: 'Normal',
      WhatId: '006000000000001AAA',
    }),
  );
  expect(payload.calls).toEqual([
    expect.objectContaining({
      method: 'PATCH',
      path: '/services/data/v61.0/sobjects/Opportunity/006000000000001AAA',
    }),
    expect.objectContaining({
      method: 'POST',
      path: '/services/data/v61.0/sobjects/Task',
    }),
  ]);
  expect(payload.queryCount).toBe(2);
});

test('salesforce helper resolves fuzzy record names with one SOQL query', () => {
  const result = runAssertion('single-query-fuzzy-resolution');

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.record).toEqual(
    expect.objectContaining({
      Id: '006000000000001AAA',
      Name: 'Acme Renewal',
    }),
  );
  expect(payload.queryCount).toBe(1);
  expect(payload.query).toContain("Name = 'Acme Ren'");
  expect(payload.query).toContain("Name LIKE '%Acme Ren%'");
});

test('salesforce helper routes all requests through gateway proxy', () => {
  const result = runAssertion('route-check');

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout.trim());
  expect(payload.ok).toBe(true);
});

test('salesforce helper never touches secrets directly', () => {
  const result = runAssertion('secret-scan');

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('ok');
});
