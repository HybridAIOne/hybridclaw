import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'airtable',
  'airtable.cjs',
);
const skillPath = path.join(process.cwd(), 'skills', 'airtable', 'SKILL.md');
const schemaPath = path.join(
  process.cwd(),
  'skills',
  'airtable',
  'fixtures',
  'schema.json',
);
const scenariosPath = path.join(
  process.cwd(),
  'skills',
  'airtable',
  'evals',
  'scenarios.json',
);

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('Airtable skill manifest declares productivity category and safety metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: airtable');
  expect(skill).toContain('category: productivity');
  expect(skill).toContain('issue: 908');
  expect(skill).toContain('stakes_tiers:');
  expect(skill).toContain('formula-field-read');
  expect(skill).toContain('attachment-update');
  expect(skill).toContain('record-delete');
  expect(skill).toContain('AIRTABLE_PAT');
  expect(skill).toContain('field-aware record creation');
  expect(skill).toContain('Formula, lookup, rollup, count');
  expect(skill).toContain('UsageTotals');
});

test('Airtable helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Airtable skill helper');
  expect(result.stdout).toContain('list-bases');
  expect(result.stdout).toContain('schema');
  expect(result.stdout).toContain('list-records');
  expect(result.stdout).toContain('create-record');
  expect(result.stdout).toContain('validate-fields');
  expect(result.stdout).toContain('attachment-payload');
  expect(result.stdout).toContain('eval-scenarios');
});

test('Airtable helper plans reads, writes, attachments, and deletes offline', () => {
  const read = runHelper([
    '--format',
    'json',
    'plan',
    'Read the formula field for total contract value',
  ]);
  const create = runHelper([
    '--format',
    'json',
    'plan',
    'Create a new lead record in Airtable',
  ]);
  const attachment = runHelper([
    '--format',
    'json',
    'plan',
    'Attach the signed PDF to this Airtable record',
  ]);
  const deletion = runHelper([
    '--format',
    'json',
    'plan',
    'Delete the stale Airtable record',
  ]);

  expect(read.status).toBe(0);
  expect(create.status).toBe(0);
  expect(attachment.status).toBe(0);
  expect(deletion.status).toBe(0);
  expect(JSON.parse(read.stdout)).toMatchObject({
    operation: 'record-read',
    stakesTier: 'green',
    computedFieldRead: true,
  });
  expect(JSON.parse(create.stdout)).toMatchObject({
    operation: 'record-create',
    stakesTier: 'amber',
    requiredGrant: 'approve-airtable-record-create',
  });
  expect(JSON.parse(attachment.stdout)).toMatchObject({
    operation: 'attachment-update',
    stakesTier: 'amber',
    requiredGrant: 'approve-airtable-attachment-update',
  });
  expect(JSON.parse(deletion.stdout)).toMatchObject({
    operation: 'record-delete',
    stakesTier: 'red',
    requiredGrant: 'approve-airtable-record-delete',
  });
});

test('Airtable helper emits gateway-proxied read requests without secrets', () => {
  const list = runHelper([
    '--format',
    'json',
    'http-request',
    'list-records',
    '--base-id',
    'appBase',
    '--table',
    'tblPipeline',
    '--field',
    'Name',
    '--field',
    'Status',
    '--filter-by-formula',
    "{Status} = 'Active'",
    '--page-size',
    '50',
  ]);

  expect(list.status).toBe(0);
  const payload = JSON.parse(list.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'GET',
    bearerSecretName: 'AIRTABLE_PAT',
    skillName: 'airtable',
  });
  expect(payload.httpRequest.url).toContain(
    'https://api.airtable.com/v0/appBase/tblPipeline?',
  );
  expect(payload.httpRequest.url).toContain('pageSize=50');
  expect(payload.httpRequest.url).toContain('fields%5B%5D=Name');
  expect(payload.httpRequest.url).toContain('fields%5B%5D=Status');
  expect(list.stdout).not.toContain('pat');
  expect(payload.costMeasurement.system).toBe('UsageTotals');
});

test('Airtable helper validates fields before creating record payloads', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'create-record',
    '--base-id',
    'appBase',
    '--table',
    'Pipeline',
    '--fields-json',
    '{"Name":"Acme GmbH","Status":"Active","Tags":["DACH"],"Amount":1200,"Closed":false,"Due Date":"2026-05-31","Files":[{"url":"https://example.com/file.pdf","filename":"file.pdf"}],"Related Accounts":["rec12345678901234"]}',
    '--schema-file',
    schemaPath,
    '--operator-grant',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.airtable.com/v0/appBase/Pipeline',
  });
  expect(payload.httpRequest.json.records[0].fields).toMatchObject({
    Name: 'Acme GmbH',
    Status: 'Active',
    Amount: 1200,
  });
});

test('Airtable helper refuses computed field writes and bad select choices', () => {
  const computed = runHelper([
    '--format',
    'json',
    'validate-fields',
    '--schema-file',
    schemaPath,
    '--table',
    'Pipeline',
    '--fields-json',
    '{"Total Contract Value":9000}',
  ]);
  const badChoice = runHelper([
    '--format',
    'json',
    'validate-fields',
    '--schema-file',
    schemaPath,
    '--table',
    'Pipeline',
    '--fields-json',
    '{"Status":"Blocked"}',
  ]);

  expect(computed.status).toBe(0);
  expect(badChoice.status).toBe(0);
  expect(JSON.parse(computed.stdout)).toMatchObject({
    allowed: false,
    findings: ['Total Contract Value is a computed/read-only formula field.'],
  });
  expect(JSON.parse(badChoice.stdout)).toMatchObject({
    allowed: false,
    findings: ['Status must be one of: New, Active, Closed.'],
  });
});

test('Airtable helper requires operator grants before write request emission', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'delete-record',
    '--base-id',
    'appBase',
    '--table',
    'tblPipeline',
    '--record-id',
    'rec12345678901234',
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    'Refusing Airtable write without --operator-grant',
  );
});

test('Airtable helper prepares attachment payloads', () => {
  const result = runHelper([
    '--format',
    'json',
    'attachment-payload',
    '--field',
    'Files',
    '--url',
    'https://example.com/signed.pdf',
    '--filename',
    'signed.pdf',
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    fields: {
      Files: [
        { url: 'https://example.com/signed.pdf', filename: 'signed.pdf' },
      ],
    },
    costMeasurement: { system: 'UsageTotals' },
  });
});

test('Airtable helper eval suite covers roadmap behaviors', () => {
  const scenarios = JSON.parse(
    fs.readFileSync(scenariosPath, 'utf-8'),
  ) as Array<{ category?: string; expected?: { costSystem?: string } }>;
  const categories = new Set(scenarios.map((scenario) => scenario.category));

  expect(scenarios).toHaveLength(8);
  expect(categories).toEqual(
    new Set([
      'schema-read',
      'record-read',
      'computed-read',
      'record-write',
      'destructive-write',
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
  expect(payload.scenarioCount).toBe(8);
  expect(payload.failed).toBe(0);
  expect(payload.categories).toMatchObject({
    'schema-read': 2,
    'record-read': 1,
    'computed-read': 1,
    'record-write': 3,
    'destructive-write': 1,
  });
});
