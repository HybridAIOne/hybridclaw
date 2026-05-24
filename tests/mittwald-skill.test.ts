import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'mittwald',
  'mittwald.cjs',
);
const skillPath = path.join(process.cwd(), 'skills', 'mittwald', 'SKILL.md');
const require = createRequire(import.meta.url);
type LoosePayload = Record<string, unknown> & {
  approval: Record<string, unknown>;
  costMeasurement: Record<string, unknown>;
  eventConsistency: Record<string, unknown> & {
    followUp: Record<string, unknown>;
  };
  httpRequest: Record<string, unknown>;
  httpRequests: Array<Record<string, unknown>>;
  rateLimit: Record<string, unknown>;
  secretPolicy: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
};
const mittwald = require('../skills/mittwald/mittwald.cjs') as {
  commandClassifyResponse: (args: string[]) => LoosePayload;
  commandEventFollowUp: (args: string[]) => LoosePayload;
  commandHttpRequest: (args: string[]) => LoosePayload;
  commandPlan: (args: string[]) => LoosePayload;
};

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

function buildHttp(args: string[]) {
  return mittwald.commandHttpRequest([...args]);
}

function buildPlan(args: string[]) {
  return mittwald.commandPlan([...args]);
}

function buildFollowUp(args: string[]) {
  return mittwald.commandEventFollowUp([...args]);
}

function classify(args: string[]) {
  return mittwald.commandClassifyResponse([...args]);
}

test('mittwald skill manifest declares SecretRef credential metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, {
    name: 'mittwald',
  });

  expect(manifest.credentials).toEqual([
    expect.objectContaining({
      id: 'mittwald-api-token',
      kind: 'bearer',
      required: true,
      secretRef: {
        source: 'store',
        id: 'MITTWALD_API_TOKEN',
      },
      scope: 'https://api.mittwald.de Authorization bearer',
    }),
  ]);
  expect(skill).toContain('id: mittwald-api-token');
  expect(skill).toContain('id: MITTWALD_API_TOKEN');
  expect(skill).toContain('R21.104');
  expect(skill).toContain('issue: 1068');
  expect(skill).toContain('Terraform');
  expect(skill).toContain('MCP');
  expect(skill).not.toContain('- containers');
  expect(skill).not.toContain('- files');
  expect(skill).not.toContain('- mail\n');
  expect(skill).not.toContain('- deploy-check');
});

test('mittwald helper exposes expected read commands', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('mittwald skill helper');
  expect(result.stdout).toContain('whoami');
  expect(result.stdout).toContain('projects');
  expect(result.stdout).toContain('databases');
  expect(result.stdout).toContain('deploy-check');
  expect(result.stdout).toContain('restore-backup');
  expect(result.stdout).toContain('schedule-domain-deletion');
  expect(result.stdout).toContain('cancel-domain-deletion');
  expect(result.stdout).toContain('change-domain-project');
  expect(result.stdout).toContain('validate-license-key');
  expect(result.stdout).toContain('create-delivery-box');
});

test('mittwald helper emits SecretRef-backed whoami request without secrets', () => {
  const payload = buildHttp(['whoami']);

  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'whoami',
    stakesTier: 'green',
    httpRequest: {
      url: 'https://api.mittwald.de/v2/user',
      method: 'GET',
      bearerSecretName: 'MITTWALD_API_TOKEN',
      skillName: 'mittwald',
      stakesTier: 'green',
    },
    costMeasurement: {
      system: 'UsageTotals',
      subLimitKey: 'mittwald',
    },
  });
  expect(JSON.stringify(payload)).not.toContain('Authorization');
  expect(JSON.stringify(payload)).not.toContain('X-Access-Token');
  expect(JSON.stringify(payload)).not.toContain('mittwald-api-token');
});

test('mittwald helper builds bounded project list requests', () => {
  const payload = buildHttp([
    'projects',
    '--limit',
    '25',
    '--search-term',
    'shop',
  ]);
  const url = new URL(payload.httpRequest.url);

  expect(url.origin + url.pathname).toBe('https://api.mittwald.de/v2/projects');
  expect(url.searchParams.get('limit')).toBe('25');
  expect(url.searchParams.get('searchTerm')).toBe('shop');

  const tooLarge = runHelper([
    '--format',
    'json',
    'http-request',
    'projects',
    '--limit',
    '101',
  ]);
  expect(tooLarge.status).toBe(1);
  expect(tooLarge.stderr).toContain('--limit must be at most 100');
});

test('mittwald helper builds project-scoped endpoint URLs safely', () => {
  const apps = buildHttp([
    'apps',
    '--project-id',
    'project/with spaces',
    '--limit',
    '10',
  ]);
  const domains = buildHttp([
    'domains',
    '--project-id',
    'project-id',
    '--domain-search-name',
    'example.com',
  ]);
  const serviceLogs = buildHttp([
    'service-logs',
    '--stack-id',
    'stack id',
    '--service-id',
    'svc/id',
    '--tail',
    '123',
  ]);

  expect(apps.httpRequest.url).toBe(
    'https://api.mittwald.de/v2/projects/project%2Fwith%20spaces/app-installations?limit=10',
  );
  expect(domains.httpRequest.url).toBe(
    'https://api.mittwald.de/v2/projects/project-id/domains?limit=50&domainSearchName=example.com',
  );
  expect(serviceLogs.httpRequest.url).toBe(
    'https://api.mittwald.de/v2/stacks/stack%20id/services/svc%2Fid/logs?tail=123',
  );
});

test('mittwald databases command emits MySQL and Redis httpRequest payloads', () => {
  const payload = buildHttp(['databases', '--project-id', 'project-id']);

  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'databases',
    stakesTier: 'green',
    httpRequests: [
      {
        url: 'https://api.mittwald.de/v2/projects/project-id/mysql-databases',
        bearerSecretName: 'MITTWALD_API_TOKEN',
      },
      {
        url: 'https://api.mittwald.de/v2/projects/project-id/redis-databases',
        bearerSecretName: 'MITTWALD_API_TOKEN',
      },
    ],
  });
});

test('mittwald helper rejects arbitrary endpoint passthrough', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'raw',
    '--path',
    '/v2/projects',
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Unknown mittwald http-request operation');
});

test('mittwald guarded writes require exact operator grant', () => {
  const withoutGrant = runHelper([
    '--format',
    'json',
    'http-request',
    'app-action',
    '--app-installation-id',
    'app-123',
    '--action',
    'restart',
  ]);

  expect(withoutGrant.status).toBe(1);
  expect(withoutGrant.stderr).toContain(
    'requires exact F8/F14 operator approval',
  );
  expect(withoutGrant.stderr).toContain('app-installation:app-123');
});

test('mittwald guarded app action emits red request with target approval and follow-up', () => {
  const payload = buildHttp([
    'app-action',
    '--app-installation-id',
    'app/123',
    '--action',
    'restart',
    '--operator-grant',
  ]);

  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'app-action',
    stakesTier: 'red',
    httpRequest: {
      url: 'https://api.mittwald.de/v2/app-installations/app%2F123/actions/restart',
      method: 'POST',
      bearerSecretName: 'MITTWALD_API_TOKEN',
      stakesTier: 'red',
    },
    approval: {
      route: 'f14',
      requiredGrant:
        'approve-mittwald-app-action:app-installation:app/123 action:restart',
      target: 'app-installation:app/123 action:restart',
    },
    eventConsistency: {
      responseEventHeader: 'etag',
      requestHeader: 'if-event-reached',
    },
  });
  expect(payload.eventConsistency.followUp.argv).toEqual([
    'node',
    'skills/mittwald/mittwald.cjs',
    '--format',
    'json',
    'event-follow-up',
    'app-action',
    '--app-installation-id',
    'app/123',
    '--event-id',
    '<etag>',
  ]);
  expect(JSON.stringify(payload)).not.toContain('Authorization');
  expect(JSON.stringify(payload)).not.toContain('app%252F123');
});

test('mittwald guarded database creation uses secret placeholders and bounded follow-up', () => {
  const payload = buildHttp([
    'create-mysql-database',
    '--project-id',
    'project-id',
    '--description',
    'app-prod',
    '--version',
    '8.4',
    '--password-secret',
    'MITTWALD_MYSQL_PASSWORD',
    '--operator-grant',
  ]);
  const followUp = buildFollowUp([
    'create-mysql-database',
    '--project-id',
    'project-id',
    '--event-id',
    'event-123',
  ]);

  expect(payload).toMatchObject({
    operation: 'create-mysql-database',
    stakesTier: 'amber',
    httpRequest: {
      url: 'https://api.mittwald.de/v2/projects/project-id/mysql-databases',
      method: 'POST',
      json: {
        database: {
          description: 'app-prod',
          version: '8.4',
        },
        user: {
          accessLevel: 'full',
          password: '<secret:MITTWALD_MYSQL_PASSWORD>',
        },
      },
    },
  });
  expect(payload.approval.requiredGrant).toContain('project:project-id');
  expect(JSON.stringify(payload)).not.toContain('mysql-password-value');
  expect(followUp).toMatchObject({
    command: 'event-follow-up',
    originalOperation: 'create-mysql-database',
    httpRequests: [
      {
        headers: {
          'if-event-reached': 'event-123',
        },
      },
      {
        headers: {
          'if-event-reached': 'event-123',
        },
      },
    ],
  });
});

test('mittwald guarded backup restore and marketplace order are red operations', () => {
  const restore = buildHttp([
    'restore-backup-path',
    '--backup-id',
    'backup-123',
    '--source-path',
    '/html',
    '--target-path',
    '/html-restore',
    '--operator-grant',
  ]);
  const marketplace = buildHttp([
    'order-extension',
    '--extension-id',
    'extension-123',
    '--body-json',
    '{"projectId":"project-id","consentedScopes":[]}',
    '--operator-grant',
  ]);

  expect(restore).toMatchObject({
    operation: 'restore-backup-path',
    stakesTier: 'red',
    httpRequest: {
      url: 'https://api.mittwald.de/v2/project-backups/backup-123/restore-path',
      method: 'POST',
      json: {
        sourcePath: '/html',
        targetPath: '/html-restore',
        clearTargetPath: false,
      },
    },
  });
  expect(restore.approval.requiredGrant).toContain('project-backup:backup-123');
  expect(marketplace).toMatchObject({
    operation: 'order-extension',
    stakesTier: 'red',
    httpRequest: {
      url: 'https://api.mittwald.de/v2/extensions/extension-123/order',
      method: 'POST',
      json: {
        projectId: 'project-id',
        consentedScopes: [],
      },
    },
  });
  expect(marketplace.approval.requiredGrant).toContain(
    'extension:extension-123',
  );
});

test('mittwald guarded domain changes include target ids and consistency reads', () => {
  const payload = buildHttp([
    'update-domain-nameservers',
    '--domain-id',
    'domain-123',
    '--nameserver',
    'ns1.example.com',
    '--nameserver',
    'ns2.example.com',
    '--operator-grant',
  ]);
  const followUp = buildFollowUp([
    'update-domain-nameservers',
    '--domain-id',
    'domain-123',
    '--event-id',
    'event-456',
  ]);

  expect(payload).toMatchObject({
    operation: 'update-domain-nameservers',
    stakesTier: 'amber',
    httpRequest: {
      url: 'https://api.mittwald.de/v2/domains/domain-123/nameservers',
      method: 'PATCH',
      json: {
        nameservers: ['ns1.example.com', 'ns2.example.com'],
      },
    },
  });
  expect(payload.approval.requiredGrant).toContain('domain:domain-123');
  expect(followUp).toMatchObject({
    command: 'event-follow-up',
    originalOperation: 'update-domain-nameservers',
    httpRequest: {
      url: 'https://api.mittwald.de/v2/domains/domain-123',
      headers: {
        'if-event-reached': 'event-456',
      },
    },
  });
});

test('mittwald non-mutating domain availability does not require grant or follow-up', () => {
  const payload = buildHttp([
    'check-domain-availability',
    '--domain',
    'example.com',
  ]);

  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'check-domain-availability',
    stakesTier: 'green',
    httpRequest: {
      url: 'https://api.mittwald.de/v2/domains',
      method: 'POST',
      json: {
        domain: 'example.com',
      },
    },
  });
  expect(payload).not.toHaveProperty('approval');
  expect(payload).not.toHaveProperty('eventConsistency');
});

test('mittwald validates risky write bodies and deletion timestamps early', () => {
  const invalidDate = runHelper([
    '--format',
    'json',
    'http-request',
    'schedule-domain-deletion',
    '--domain-id',
    'domain-123',
    '--deletion-date',
    'tomorrow',
    '--operator-grant',
  ]);
  const invalidOrder = runHelper([
    '--format',
    'json',
    'http-request',
    'order-extension',
    '--extension-id',
    'extension-123',
    '--body-json',
    '{"consentedScopes":[]}',
    '--operator-grant',
  ]);
  const invalidRestore = runHelper([
    '--format',
    'json',
    'http-request',
    'restore-backup',
    '--backup-id',
    'backup-123',
    '--body-json',
    '{"restoreType":"surprise"}',
    '--operator-grant',
  ]);

  expect(invalidDate.status).toBe(1);
  expect(invalidDate.stderr).toContain('ISO 8601 UTC timestamp');
  expect(invalidOrder.status).toBe(1);
  expect(invalidOrder.stderr).toContain('requires projectId or customerId');
  expect(invalidRestore.status).toBe(1);
  expect(invalidRestore.stderr).toContain(
    'requires pathRestore or databaseRestores',
  );
});

test('mittwald app id fallback has explicit error label', () => {
  const result = runHelper(['--format', 'json', 'http-request', 'app-status']);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--app-installation-id (or --app-id)');
});

test('mittwald ssh and sftp list operations share pagination parsing', () => {
  const ssh = buildHttp([
    'ssh-users',
    '--project-id',
    'project-id',
    '--limit',
    '10',
    '--page',
    '2',
  ]);
  const sftp = buildHttp([
    'sftp-users',
    '--project-id',
    'project-id',
    '--limit',
    '10',
    '--page',
    '3',
  ]);

  expect(new URL(ssh.httpRequest.url).searchParams.get('page')).toBe('2');
  expect(new URL(sftp.httpRequest.url).searchParams.get('page')).toBe('3');
});

test('mittwald deploy-check plan is read-only and SecretRef-aware', () => {
  const payload = buildPlan(['deploy-check', '--project-id', 'project-id']);

  expect(payload).toMatchObject({
    command: 'plan',
    plan: 'deploy-check',
    stakesTier: 'green',
    requiredGrant: null,
    secretPolicy: {
      bearerSecretName: 'MITTWALD_API_TOKEN',
      modelSeesToken: false,
    },
  });
  expect(
    payload.steps.map((step: { operation: string }) => step.operation),
  ).toEqual([
    'project',
    'apps',
    'databases',
    'domains',
    'ingresses',
    'cronjobs',
    'backups',
    'services',
  ]);
  expect(payload.steps[0]).toMatchObject({
    argv: [
      'node',
      'skills/mittwald/mittwald.cjs',
      '--format',
      'json',
      'http-request',
      'project',
      '--project-id',
      'project-id',
    ],
  });
  expect(payload.steps[0]).not.toHaveProperty('command');
});

test('mittwald response classifier stops auth failures and reports rate limits', () => {
  const unauthorized = classify(['--status', '403']);
  const rateLimited = classify([
    '--status',
    '429',
    '--headers-json',
    '{"X-RateLimit-Limit":"120","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"10"}',
  ]);

  expect(unauthorized).toMatchObject({
    classification: 'credential-or-permission-problem',
    retry: false,
    stopAfterFirstFailure: true,
  });
  expect(rateLimited).toMatchObject({
    classification: 'rate-limited',
    retry: true,
    retryAfter: '10',
    rateLimit: {
      limit: '120',
      remaining: '0',
      reset: '10',
    },
  });
});
