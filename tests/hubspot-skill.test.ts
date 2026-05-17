import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const helperPath = path.join(process.cwd(), 'skills', 'hubspot', 'hubspot.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'hubspot', 'SKILL.md');
const scenariosPath = path.join(
  process.cwd(),
  'skills',
  'hubspot',
  'evals',
  'scenarios.json',
);
const dealPropertiesPath = path.join(
  process.cwd(),
  'skills',
  'hubspot',
  'fixtures',
  'deal-properties.json',
);

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('HubSpot skill manifest declares OAuth, safety, and UsageTotals metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: hubspot');
  expect(skill).toContain('category: business');
  expect(skill).toContain('stakes_tiers:');
  expect(skill).toContain('HUBSPOT_ACCESS_TOKEN');
  expect(skill).toContain('hybridclaw auth login hubspot');
  expect(skill).toContain('deal-stage-update');
  expect(skill).toContain('lifecycle-stage-update');
  expect(skill).toContain('UsageTotals');
});

test('HubSpot helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HubSpot skill helper');
  expect(result.stdout).toContain('workflow');
  expect(result.stdout).toContain('validate-option');
  expect(result.stdout).toContain('explain-error');
  expect(result.stdout).toContain('update-deal-stage');
  expect(result.stdout).toContain('update-lifecycle-stage');
  expect(result.stdout).toContain('create-note');
  expect(result.stdout).toContain('create-task');
  expect(result.stdout).toContain('eval-scenarios');
});

test('HubSpot helper builds ordered natural-language workflow steps', () => {
  const withoutId = runHelper([
    '--format',
    'json',
    'workflow',
    'Move Acme Renewal deal to contractsent',
  ]);
  const withId = runHelper([
    '--format',
    'json',
    'workflow',
    'Move Acme Renewal deal to contractsent',
    '--record-id',
    '123456',
    '--grant',
    'approve-hubspot-deal-stage-update',
  ]);

  expect(withoutId.status).toBe(0);
  expect(withId.status).toBe(0);
  const lookupPayload = JSON.parse(withoutId.stdout);
  expect(lookupPayload.command).toBe('workflow');
  expect(lookupPayload.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'http_request',
        purpose: expect.stringContaining('Read deal properties'),
      }),
      expect.objectContaining({
        kind: 'http_request',
        purpose: expect.stringContaining('Find the target deal ID'),
      }),
      expect.objectContaining({
        kind: 'operator',
        requiredInput: 'deal record id',
      }),
    ]),
  );

  const executablePayload = JSON.parse(withId.stdout);
  expect(executablePayload.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'http_request',
        requiredGrant: 'approve-hubspot-deal-stage-update',
        httpRequest: expect.objectContaining({
          method: 'PATCH',
          url: 'https://api.hubapi.com/crm/v3/objects/deals/123456',
        }),
      }),
    ]),
  );
});

test('HubSpot helper plans reads and guarded writes offline', () => {
  const read = runHelper([
    '--format',
    'json',
    'plan',
    'Find the Acme Renewal deal',
  ]);
  const stage = runHelper([
    '--format',
    'json',
    'plan',
    'Move Acme Renewal deal to contractsent',
  ]);
  const dealStageRead = runHelper([
    '--format',
    'json',
    'plan',
    'Read the current deal stage for Q3 Renewal',
  ]);
  const lifecycleRead = runHelper([
    '--format',
    'json',
    'plan',
    'Read the lifecycle stage for contact Priya Shah',
  ]);
  const lifecycle = runHelper([
    '--format',
    'json',
    'plan',
    'Update Jane contact lifecycle stage to marketingqualifiedlead',
  ]);
  const note = runHelper([
    '--format',
    'json',
    'plan',
    'Log a note on the Acme deal saying "Legal review started"',
  ]);
  const task = runHelper([
    '--format',
    'json',
    'plan',
    'Create a task for contact Lee Chen: "Send pricing"',
  ]);

  expect(read.status).toBe(0);
  expect(stage.status).toBe(0);
  expect(dealStageRead.status).toBe(0);
  expect(lifecycleRead.status).toBe(0);
  expect(lifecycle.status).toBe(0);
  expect(note.status).toBe(0);
  expect(task.status).toBe(0);
  expect(JSON.parse(read.stdout).actions[0]).toMatchObject({
    action: 'search-records',
    object: 'deals',
    stakesTier: 'green',
  });
  const stageAction = JSON.parse(stage.stdout).actions[0];
  expect(stageAction).toMatchObject({
    action: 'update-deal-stage',
    deal: 'Acme Renewal',
    stage: 'contractsent',
    stakesTier: 'amber',
    requiredGrant: 'approve-hubspot-deal-stage-update',
  });
  expect(JSON.parse(dealStageRead.stdout).actions).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'update-deal-stage' }),
    ]),
  );
  expect(JSON.parse(lifecycleRead.stdout).actions).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'update-lifecycle-stage' }),
    ]),
  );
  expect(JSON.parse(lifecycle.stdout).actions[0]).toMatchObject({
    action: 'update-lifecycle-stage',
    object: 'contacts',
    requiredGrant: 'approve-hubspot-lifecycle-stage-update',
  });
  expect(JSON.parse(note.stdout).actions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'create-note',
        requiredGrant: 'approve-hubspot-note-create',
      }),
    ]),
  );
  expect(JSON.parse(task.stdout).actions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'create-task',
        requiredGrant: 'approve-hubspot-task-create',
      }),
    ]),
  );
});

test('HubSpot helper extracts deal stage updates without capturing filler words', () => {
  const stageAfterObject = runHelper([
    '--format',
    'json',
    'plan',
    'Set the Q3 Renewal deal stage to presentationscheduled',
  ]);
  const stageForDeal = runHelper([
    '--format',
    'json',
    'plan',
    'Change the deal stage for Northwind Expansion to decisionmakerboughtin',
  ]);

  expect(stageAfterObject.status).toBe(0);
  expect(stageForDeal.status).toBe(0);
  expect(JSON.parse(stageAfterObject.stdout).actions[0]).toMatchObject({
    action: 'update-deal-stage',
    deal: 'Q3 Renewal',
    stage: 'presentationscheduled',
  });
  expect(JSON.parse(stageForDeal.stdout).actions[0]).toMatchObject({
    action: 'update-deal-stage',
    deal: 'Northwind Expansion',
    stage: 'decisionmakerboughtin',
  });
});

test('HubSpot helper emits gateway-minted OAuth read requests', () => {
  const result = runHelper([
    '--format',
    'json',
    '--max-response-bytes',
    '2048',
    'http-request',
    'search',
    'deals',
    '--query',
    'Acme',
    '--limit',
    '10',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    url: 'https://api.hubapi.com/crm/v3/objects/deals/search',
    method: 'POST',
    bearerSecretName: 'HUBSPOT_ACCESS_TOKEN',
    skillName: 'hubspot',
    maxResponseBytes: 2048,
  });
  expect(payload.httpRequest.json).toMatchObject({
    limit: 10,
    properties: expect.arrayContaining(['dealname', 'dealstage']),
  });
  expect(payload.httpRequest.json.filterGroups.length).toBeGreaterThan(0);
  expect(payload.costMeasurement.system).toBe('UsageTotals');
  expect(result.stdout).not.toContain('refresh');
});

test('HubSpot helper requires explicit grant for write requests', () => {
  const denied = runHelper([
    '--format',
    'json',
    'http-request',
    'update-deal-stage',
    '123456',
    '--stage',
    'contractsent',
  ]);
  const allowed = runHelper([
    '--format',
    'json',
    'http-request',
    'update-deal-stage',
    '123456',
    '--stage',
    'contractsent',
    '--grant',
    'approve-hubspot-deal-stage-update',
  ]);

  expect(denied.status).not.toBe(0);
  expect(denied.stderr).toContain('approve-hubspot-deal-stage-update');
  expect(allowed.status).toBe(0);
  const payload = JSON.parse(allowed.stdout);
  expect(payload.httpRequest).toMatchObject({
    url: 'https://api.hubapi.com/crm/v3/objects/deals/123456',
    method: 'PATCH',
    bearerSecretName: 'HUBSPOT_ACCESS_TOKEN',
  });
  expect(payload.httpRequest.json).toEqual({
    properties: { dealstage: 'contractsent' },
  });
});

test('HubSpot helper validates internal stage options from saved metadata', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubspot-skill-'));
  const brokenPropertiesPath = path.join(
    tempDir,
    'broken-deal-properties.json',
  );
  fs.writeFileSync(
    brokenPropertiesPath,
    JSON.stringify({
      results: [
        {
          name: 'dealstage',
          options: [{ label: 'Label only', value: '' }],
        },
      ],
    }),
  );
  const valid = runHelper([
    '--format',
    'json',
    'validate-option',
    '--properties-file',
    dealPropertiesPath,
    '--property',
    'dealstage',
    '--value',
    'contractsent',
  ]);
  const labelWrite = runHelper([
    '--format',
    'json',
    'http-request',
    'update-deal-stage',
    '123456',
    '--stage',
    'Contract sent',
    '--properties-file',
    dealPropertiesPath,
    '--grant',
    'approve-hubspot-deal-stage-update',
  ]);
  const invalid = runHelper([
    '--format',
    'json',
    'http-request',
    'update-deal-stage',
    '123456',
    '--stage',
    'Contract Sent',
    '--properties-file',
    dealPropertiesPath,
    '--grant',
    'approve-hubspot-deal-stage-update',
  ]);
  const labelOnly = runHelper([
    '--format',
    'json',
    'validate-option',
    '--properties-file',
    brokenPropertiesPath,
    '--property',
    'dealstage',
    '--value',
    'Label only',
  ]);

  expect(valid.status).toBe(0);
  expect(labelWrite.status).toBe(0);
  expect(JSON.parse(valid.stdout)).toMatchObject({
    command: 'validate-option',
    propertyName: 'dealstage',
    value: 'contractsent',
    ok: true,
  });
  expect(JSON.parse(labelWrite.stdout).httpRequest.json).toEqual({
    properties: { dealstage: 'contractsent' },
  });
  expect(invalid.status).not.toBe(0);
  expect(invalid.stderr).toContain('Invalid dealstage value');
  expect(invalid.stderr).toContain('contractsent');
  expect(labelOnly.status).not.toBe(0);
  expect(labelOnly.stderr).toContain('missing an internal value');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('HubSpot helper interprets authentication, authorization, and stage errors', () => {
  const auth = runHelper([
    '--format',
    'json',
    'explain-error',
    '--status',
    '401',
    '--body',
    '{"message":"Invalid OAuth token"}',
  ]);
  const scope = runHelper([
    '--format',
    'json',
    'explain-error',
    '--status',
    '403',
    '--body',
    '{"message":"missing scope crm.objects.deals.write"}',
  ]);
  const stage = runHelper([
    '--format',
    'json',
    'explain-error',
    '--status',
    '400',
    '--body',
    '{"message":"Property dealstage does not exist"}',
  ]);
  const empty = runHelper(['--format', 'json', 'explain-error']);

  expect(auth.status).toBe(0);
  expect(scope.status).toBe(0);
  expect(stage.status).toBe(0);
  expect(empty.status).not.toBe(0);
  expect(JSON.parse(auth.stdout)).toMatchObject({
    category: 'authentication',
    operatorMessage: expect.stringContaining('Do not infer token age'),
    retryable: false,
  });
  expect(JSON.parse(scope.stdout)).toMatchObject({
    category: 'authorization',
    operatorMessage: expect.stringContaining('Stop after this failed call'),
    retryable: false,
  });
  expect(JSON.parse(stage.stdout)).toMatchObject({
    category: 'deal-stage',
    retryable: false,
  });
  expect(empty.stderr).toContain(
    'explain-error requires --file, --body, or a JSON argument',
  );
});

test('HubSpot helper emits live execution auth failure policy', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'search',
    'contacts',
    '--query',
    'stephan@example.com',
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    liveExecution: {
      requiresConfiguredSecrets: ['HUBSPOT_ACCESS_TOKEN'],
      secretRefPolicy: expect.stringContaining('Do not preflight'),
      unauthorizedPolicy: expect.stringContaining(
        'stop after the first failure',
      ),
    },
  });
});

test('HubSpot helper builds note and task association payloads', () => {
  const note = runHelper([
    '--format',
    'json',
    'http-request',
    'create-note',
    '--body',
    'Legal review started',
    '--timestamp',
    '2026-05-14T10:00:00Z',
    '--associate-object',
    'deals',
    '--associate-id',
    '123456',
    '--grant',
    'approve-hubspot-note-create',
  ]);
  const task = runHelper([
    '--format',
    'json',
    'http-request',
    'create-task',
    '--subject',
    'Send pricing',
    '--due',
    '2026-05-20',
    '--associate-object',
    'contacts',
    '--associate-id',
    '987654',
    '--grant',
    'approve-hubspot-task-create',
  ]);

  expect(note.status).toBe(0);
  expect(task.status).toBe(0);
  expect(JSON.parse(note.stdout).httpRequest.json).toMatchObject({
    properties: {
      hs_note_body: 'Legal review started',
      hs_timestamp: '2026-05-14T10:00:00.000Z',
    },
    associations: [
      {
        to: { id: '123456' },
        types: [{ associationTypeId: 214 }],
      },
    ],
  });
  expect(JSON.parse(task.stdout).httpRequest.json).toMatchObject({
    properties: {
      hs_task_subject: 'Send pricing',
      hs_task_status: 'NOT_STARTED',
      hs_timestamp: '2026-05-20',
    },
    associations: [
      {
        to: { id: '987654' },
        types: [{ associationTypeId: 204 }],
      },
    ],
  });
});

test('HubSpot helper rejects partial note and task associations', () => {
  const note = runHelper([
    '--format',
    'json',
    'http-request',
    'create-note',
    '--body',
    'Legal review started',
    '--associate-object',
    'deals',
    '--grant',
    'approve-hubspot-note-create',
  ]);
  const task = runHelper([
    '--format',
    'json',
    'http-request',
    'create-task',
    '--subject',
    'Send pricing',
    '--associate-id',
    '987654',
    '--grant',
    'approve-hubspot-task-create',
  ]);

  expect(note.status).not.toBe(0);
  expect(task.status).not.toBe(0);
  expect(note.stderr).toContain(
    '--associate-object and --associate-id must be provided together',
  );
  expect(task.stderr).toContain(
    '--associate-object and --associate-id must be provided together',
  );
});

test('HubSpot helper eval suite covers 30 scenarios and UsageTotals', () => {
  const scenarios = JSON.parse(
    fs.readFileSync(scenariosPath, 'utf-8'),
  ) as Array<{
    category?: string;
    costMeasurement?: { system?: string };
    expectedActions?: string[];
    id?: string;
  }>;

  expect(scenarios).toHaveLength(30);
  expect(
    scenarios.every(
      (scenario) => scenario.costMeasurement?.system === 'UsageTotals',
    ),
  ).toBe(true);

  const result = runHelper(['--format', 'json', 'eval-scenarios']);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.scenarioCount).toBe(30);
  expect(payload.failed).toBe(0);
  expect(payload.categories).toMatchObject({
    'read-contact': 5,
    'read-company': 5,
    'read-deal': 5,
    'write-deal-stage': 5,
    'write-lifecycle': 3,
    'write-note': 3,
    'write-task': 2,
    compound: 2,
  });
  expect(
    scenarios.find((scenario) => scenario.id === 'compound-note-task')
      ?.expectedActions,
  ).toEqual(['create-note', 'create-task']);
});
