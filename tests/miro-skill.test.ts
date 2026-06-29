import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(process.cwd(), 'skills', 'miro', 'miro.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'miro', 'SKILL.md');
const require = createRequire(import.meta.url);
const miro = require('../skills/miro/miro.cjs') as {
  captureExportArtifact: (
    commandOpts: Record<string, string>,
    options?: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    artifacts: Array<{ path: string; filename: string; bytes: number }>;
  }>;
};

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('Miro skill manifest declares credentials, safety metadata, and roadmap linkage', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, {
    name: 'miro',
  });

  expect(manifest.credentials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'miro-access-token',
        kind: 'bearer',
        required: true,
        secretRef: {
          source: 'store',
          id: 'MIRO_ACCESS_TOKEN',
        },
        scope: 'api.miro.com/v2 boards:read boards:write',
      }),
      expect.objectContaining({
        id: 'miro-discovery-access-token',
        kind: 'bearer',
        required: false,
        secretRef: {
          source: 'store',
          id: 'MIRO_DISCOVERY_ACCESS_TOKEN',
        },
        scope: 'api.miro.com/v2 boards:export',
      }),
      expect.objectContaining({
        id: 'miro-oauth-client-secret',
        kind: 'oauth',
        secretRef: {
          source: 'store',
          id: 'MIRO_CLIENT_SECRET',
        },
      }),
      expect.objectContaining({
        id: 'miro-refresh-token',
        kind: 'oauth',
        secretRef: {
          source: 'store',
          id: 'MIRO_REFRESH_TOKEN',
        },
      }),
    ]),
  );
  expect(skill).toContain('category: productivity');
  expect(skill).toContain('related_roadmap:');
  expect(skill).toContain('- R21.102');
  expect(skill).toContain('issue: 1040');
  expect(skill).toContain('approve-miro-board-write');
  expect(skill).toContain('approve-miro-export');
  expect(skill).toContain('UsageTotals');
});

test('Miro helper --help exits cleanly and documents read, write, and export commands', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Miro skill helper');
  expect(result.stdout).toContain('list-boards');
  expect(result.stdout).toContain('oauth-exchange-code');
  expect(result.stdout).toContain('list-items');
  expect(result.stdout).toContain('create-sticky-note');
  expect(result.stdout).toContain('update-text');
  expect(result.stdout).toContain('create-connector');
  expect(result.stdout).toContain('export-create');
  expect(result.stdout).toContain('capture-export');
  expect(result.stdout).not.toContain('--token <');
});

test('Miro helper builds OAuth authorize and token capture requests without raw secrets', () => {
  const authorize = runHelper([
    '--format',
    'json',
    'oauth',
    'authorize-url',
    '--client-id',
    'miro-client-id',
    '--redirect-uri',
    'http://127.0.0.1:1455/oauth2/callback',
    '--scope',
    'boards:read',
    '--scope',
    'boards:write',
    '--state',
    'state-123',
  ]);
  const exchange = runHelper([
    '--format',
    'json',
    'http-request',
    'oauth-exchange-code',
    '--redirect-uri',
    'http://127.0.0.1:1455/oauth2/callback',
  ]);
  const refresh = runHelper([
    '--format',
    'json',
    'http-request',
    'oauth-refresh-token',
  ]);

  expect(authorize.status).toBe(0);
  expect(exchange.status).toBe(0);
  expect(refresh.status).toBe(0);
  const authorizePayload = JSON.parse(authorize.stdout);
  expect(authorizePayload.authorizationUrl).toContain(
    'https://miro.com/oauth/authorize?',
  );
  expect(authorizePayload.authorizationUrl).toContain('response_type=code');
  expect(authorizePayload.authorizationUrl).toContain('client_id=miro-client-id');
  expect(authorizePayload.authorizationUrl).toContain('scope=boards%3Aread');
  expect(authorizePayload.authorizationUrl).toContain('state=state-123');

  expect(JSON.parse(exchange.stdout)).toMatchObject({
    operation: 'oauth-exchange-code',
    requiredScopes: ['oauth'],
    httpRequest: {
      url: 'https://api.miro.com/v1/oauth/token',
      method: 'POST',
      replaceSecretPlaceholders: true,
      body: expect.stringContaining('code=%3Csecret%3AMIRO_OAUTH_CODE%3E'),
      captureResponseFields: [
        { jsonPath: 'access_token', secretName: 'MIRO_ACCESS_TOKEN' },
        { jsonPath: 'refresh_token', secretName: 'MIRO_REFRESH_TOKEN' },
      ],
    },
    liveExecution: {
      capturesSecrets: ['MIRO_ACCESS_TOKEN', 'MIRO_REFRESH_TOKEN'],
    },
  });
  expect(JSON.parse(refresh.stdout).httpRequest.body).toContain(
    'refresh_token=%3Csecret%3AMIRO_REFRESH_TOKEN%3E',
  );
  expect(exchange.stdout).not.toContain('client-secret');
});

test('Miro helper emits gateway-proxied board item read requests without secrets', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'list-items',
    '--board-id',
    'uXjVOD50NUI=',
    '--type',
    'sticky_note',
    '--limit',
    '50',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'list-items',
    stakesTier: 'green',
    requiredScopes: ['boards:read'],
    httpRequest: {
      method: 'GET',
      bearerSecretName: 'MIRO_ACCESS_TOKEN',
      skillName: 'miro',
    },
    costMeasurement: {
      system: 'UsageTotals',
      subLimitKey: 'miro',
    },
  });
  expect(payload.httpRequest.url).toContain(
    'https://api.miro.com/v2/boards/uXjVOD50NUI%3D/items?',
  );
  expect(payload.httpRequest.url).toContain('type=sticky_note');
  expect(payload.httpRequest.url).toContain('limit=50');
  expect(result.stdout).not.toContain('Bearer');
});

test('Miro helper requires preview or operator grant for board writes', () => {
  const denied = runHelper([
    '--format',
    'json',
    'http-request',
    'create-sticky-note',
    '--board-id',
    'board123',
    '--content',
    'Ship the decision',
  ]);
  const preview = runHelper([
    '--format',
    'json',
    '--request',
    'http-request',
    'create-sticky-note',
    '--board-id',
    'board123',
    '--content',
    'Ship the decision',
    '--x',
    '12',
    '--y',
    '-4',
  ]);
  const approved = runHelper([
    '--format',
    'json',
    'http-request',
    'create-sticky-note',
    '--board-id',
    'board123',
    '--content',
    'Ship the decision',
    '--operator-grant',
    'approve-miro-board-write',
  ]);

  expect(denied.status).not.toBe(0);
  expect(denied.stderr).toContain(
    'requires --operator-grant approve-miro-board-write',
  );
  expect(preview.status).toBe(0);
  expect(approved.status).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({
    operation: 'create-sticky-note',
    dryRun: true,
    requiredGrant: 'approve-miro-board-write',
    httpRequest: {
      method: 'POST',
      url: 'https://api.miro.com/v2/boards/board123/sticky_notes',
      json: {
        data: {
          content: 'Ship the decision',
        },
        position: {
          x: 12,
          y: -4,
        },
      },
    },
  });
  expect(JSON.parse(approved.stdout)).toMatchObject({
    operation: 'create-sticky-note',
    dryRun: false,
    requiredGrant: 'approve-miro-board-write',
  });
});

test('Miro helper builds approval plans for connectors and Enterprise exports', () => {
  const connector = runHelper([
    '--format',
    'json',
    'approval-plan',
    'create-connector',
    '--board-id',
    'board123',
    '--start-item-id',
    'itemA',
    '--end-item-id',
    'itemB',
    '--shape',
    'straight',
  ]);
  const exportPlan = runHelper([
    '--format',
    'json',
    'approval-plan',
    'export-create',
    '--org-id',
    '3074457345821141000',
    '--board-id',
    'uXjVOD50NUI=',
    '--request-id',
    '92343229-c532-446d-b8cb-2f155bedb807',
    '--board-format',
    'PDF',
  ]);

  expect(connector.status).toBe(0);
  expect(exportPlan.status).toBe(0);
  expect(JSON.parse(connector.stdout)).toMatchObject({
    command: 'approval-plan',
    operation: 'create-connector',
    requiredGrant: 'approve-miro-board-write',
    approvedCommand: expect.arrayContaining([
      'http-request',
      'create-connector',
      '--operator-grant',
      'approve-miro-board-write',
    ]),
    preview: {
      method: 'POST',
      json: {
        startItem: {
          id: 'itemA',
          snapTo: 'auto',
        },
        endItem: {
          id: 'itemB',
          snapTo: 'auto',
        },
        shape: 'straight',
      },
    },
  });
  expect(JSON.parse(exportPlan.stdout)).toMatchObject({
    command: 'approval-plan',
    operation: 'export-create',
    requiredGrant: 'approve-miro-export',
    requiredScopes: ['boards:export'],
    preview: {
      bearerSecretName: 'MIRO_DISCOVERY_ACCESS_TOKEN',
      json: {
        boardIds: ['uXjVOD50NUI='],
        boardFormat: 'PDF',
      },
    },
  });
});

test('Miro helper captures completed export links as workspace artifacts', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miro-export-'));
  const downloadBytes = Buffer.from('miro-zip');
  const fetchMock = async () =>
    new Response(downloadBytes, {
      status: 200,
      headers: { 'content-type': 'application/zip' },
    });

  const result = await miro.captureExportArtifact(
    {
      exportUrl: 'https://export.miro.example/board.zip',
      filename: 'board.zip',
    },
    {
      fetch: fetchMock,
      workspaceRoot,
      displayRoot: '/workspace',
    },
  );

  expect(result).toMatchObject({
    success: true,
    artifacts: [
      {
        path: '/workspace/.generated-miro/board.zip',
        filename: 'board.zip',
        bytes: downloadBytes.length,
      },
    ],
  });
  expect(
    fs.readFileSync(path.join(workspaceRoot, '.generated-miro', 'board.zip')),
  ).toEqual(downloadBytes);
});

test('Miro helper rejects unsafe export capture URLs and output paths', async () => {
  await expect(
    miro.captureExportArtifact({
      exportUrl: 'http://export.miro.example/board.zip',
      filename: 'board.zip',
    }),
  ).rejects.toThrow('--export-url must use HTTPS');
  await expect(
    miro.captureExportArtifact({
      exportUrl: 'https://127.0.0.1/board.zip',
      filename: 'board.zip',
    }),
  ).rejects.toThrow('--export-url must not point to a private or local host');
  await expect(
    miro.captureExportArtifact({
      exportUrl: 'https://export.miro.example/board.zip',
      filename: '../board.zip',
    }),
  ).rejects.toThrow('--filename must be a basename');
});

test('Miro helper documents missing credential and API error handling behavior', () => {
  const missing = runHelper([
    '--format',
    'json',
    'explain-error',
    '--message',
    'Gateway secret MIRO_ACCESS_TOKEN is missing',
  ]);
  const forbidden = runHelper([
    '--format',
    'json',
    'explain-error',
    '--status',
    '403',
    '--message',
    'insufficient_scope',
  ]);
  const rateLimited = runHelper([
    '--format',
    'json',
    'explain-error',
    '--status',
    '429',
    '--message',
    'Too many requests',
  ]);
  const missingOAuthSecret = runHelper([
    '--format',
    'json',
    'explain-error',
    '--message',
    'Gateway secret MIRO_CLIENT_SECRET is unresolved',
  ]);

  expect(missing.status).toBe(0);
  expect(forbidden.status).toBe(0);
  expect(rateLimited.status).toBe(0);
  expect(missingOAuthSecret.status).toBe(0);
  expect(JSON.parse(missing.stdout)).toMatchObject({
    classification: 'missing-credential',
    credential: 'MIRO_ACCESS_TOKEN',
    retryable: false,
  });
  expect(JSON.parse(forbidden.stdout)).toMatchObject({
    classification: 'upstream-auth-or-scope',
    retryable: false,
  });
  expect(JSON.parse(rateLimited.stdout)).toMatchObject({
    classification: 'upstream-rate-limit',
    retryable: true,
  });
  expect(JSON.parse(missingOAuthSecret.stdout)).toMatchObject({
    classification: 'missing-credential',
    credential: 'MIRO_CLIENT_SECRET',
    retryable: false,
  });
});
