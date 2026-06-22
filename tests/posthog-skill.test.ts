import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'posthog',
  'posthog.cjs',
);
const skillPath = path.join(process.cwd(), 'skills', 'posthog', 'SKILL.md');

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

function runHelperAsync(args: string[], timeoutMs = 10_000) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn('node', [helperPath, ...args], {
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for PostHog helper`,
          ),
        );
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (status) => {
        clearTimeout(timeout);
        resolve({ status, stdout, stderr });
      });
    },
  );
}

async function withMockGateway(
  run: (gatewayUrl: string, captured: unknown[]) => Promise<void>,
  responsePayload: unknown = {
    ok: true,
    status: 200,
    bodyJson: { results: [{ event: '$pageview', count: 42 }] },
  },
) {
  const captured: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      captured.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address !== 'object') {
      throw new Error('Expected server address.');
    }
    await run(`http://127.0.0.1:${address.port}`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('PostHog skill manifest declares business metadata and credential rails', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'posthog' });

  expect(manifest.credentials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'posthog-project-token',
        kind: 'api_key',
        required: true,
        secretRef: {
          source: 'store',
          id: 'POSTHOG_PROJECT_TOKEN',
        },
      }),
      expect.objectContaining({
        id: 'posthog-personal-api-key',
        kind: 'bearer',
        required: true,
        secretRef: {
          source: 'store',
          id: 'POSTHOG_PERSONAL_API_KEY',
        },
      }),
    ]),
  );
  expect(manifest.requiredCredentials).toEqual(
    expect.arrayContaining([
      { id: 'posthog-project-token', required: true },
      { id: 'posthog-personal-api-key', required: true },
    ]),
  );
  expect(manifest.configVariables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ env: 'POSTHOG_HOST', required: true }),
      expect.objectContaining({ env: 'POSTHOG_INGEST_HOST', required: true }),
      expect.objectContaining({ env: 'POSTHOG_PROJECT_ID', required: true }),
      expect.objectContaining({
        env: 'POSTHOG_ENVIRONMENT_ID',
        required: false,
      }),
    ]),
  );
  expect(skill).toContain('category: business');
  expect(skill).toContain('related_roadmap:');
  expect(skill).toContain('- R21.82');
  expect(skill).toContain('issue: 1168');
  expect(skill).toContain('event-capture');
  expect(skill).toContain('feature-flag-create-update-delete');
  expect(skill).toContain('UsageTotals');
  expect(skill).toContain('/secret set POSTHOG_PROJECT_TOKEN');
  expect(skill).toContain('/env set POSTHOG_HOST');
});

test('PostHog helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('PostHog skill helper');
  expect(result.stdout).toContain('run <http-request operation>');
  expect(result.stdout).toContain('capture-event');
  expect(result.stdout).toContain('identify-person');
  expect(result.stdout).toContain('list-persons');
  expect(result.stdout).toContain('list-feature-flags');
  expect(result.stdout).toContain('test-feature-flag');
  expect(result.stdout).toContain('query-status');
  expect(result.stdout).toContain('approve-posthog-event-capture');
});

test('PostHog helper run posts helper-built requests through the gateway', async () => {
  await withMockGateway(async (gatewayUrl, captured) => {
    const result = await runHelperAsync([
      '--format',
      'json',
      '--host',
      'https://us.posthog.com',
      '--project-id',
      '123',
      'run',
      '--gateway-url',
      gatewayUrl,
      'query',
      '--hogql',
      'select event, count() from events group by event limit 10',
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      command: 'run',
      operation: 'query',
      stakesTier: 'green',
      response: {
        ok: true,
        status: 200,
      },
      liveExecution: {
        gatewayUrl,
        skillName: 'posthog',
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      url: 'https://us.posthog.com/api/projects/123/query/',
      method: 'POST',
      bearerSecretName: 'POSTHOG_PERSONAL_API_KEY',
      skillName: 'posthog',
      json: {
        query: {
          kind: 'HogQLQuery',
          query: 'select event, count() from events group by event limit 10',
        },
      },
    });
  });
});

test('PostHog helper run interprets gateway missing-secret failures', async () => {
  await withMockGateway(
    async (gatewayUrl) => {
      const result = await runHelperAsync([
        '--format',
        'json',
        'run',
        '--gateway-url',
        gatewayUrl,
        'list-feature-flags',
      ]);

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        command: 'run',
        operation: 'list-feature-flags',
        interpretedError: {
          category: 'missing-secret',
          operatorMessage: expect.stringContaining('/secret set'),
        },
      });
    },
    {
      ok: false,
      status: 400,
      error: 'Stored secret POSTHOG_PERSONAL_API_KEY is not set.',
    },
  );
});

test('PostHog helper plans reads, guarded writes, and unsupported mutations', () => {
  const flagRead = runHelper([
    '--format',
    'json',
    'plan',
    'Show PostHog feature flags for checkout',
  ]);
  const capture = runHelper([
    '--format',
    'json',
    'plan',
    'Capture trial_started in PostHog',
  ]);
  const flagMutation = runHelper([
    '--format',
    'json',
    'plan',
    'Update the checkout feature flag rollout to 50 percent',
  ]);

  expect(flagRead.status).toBe(0);
  expect(capture.status).toBe(0);
  expect(flagMutation.status).toBe(0);
  expect(JSON.parse(flagRead.stdout)).toMatchObject({
    operation: 'feature-flag-read',
    stakesTier: 'green',
    requiresEscalation: false,
  });
  expect(JSON.parse(capture.stdout)).toMatchObject({
    operation: 'capture-event',
    stakesTier: 'amber',
    requiredGrant: 'approve-posthog-event-capture',
  });
  expect(JSON.parse(flagMutation.stdout)).toMatchObject({
    operation: 'feature-flag-mutation',
    stakesTier: 'red',
    supported: false,
  });
});

test('PostHog helper refuses capture writes without explicit operator grant', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'capture-event',
    '--event',
    'trial_started',
    '--distinct-id',
    'user_123',
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Refusing PostHog write without --operator-grant');
  expect(result.stderr).toContain('approve-posthog-event-capture');
});

test('PostHog helper emits capture request with project-token placeholder', () => {
  const result = runHelper([
    '--format',
    'json',
    '--ingest-host',
    'https://us.i.posthog.com',
    'http-request',
    'capture-event',
    '--event',
    'trial_started',
    '--distinct-id',
    'user_123',
    '--properties-json',
    '{"plan":"pro","source":"checkout"}',
    '--operator-grant',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'capture-event',
    stakesTier: 'amber',
    httpRequest: {
      url: 'https://us.i.posthog.com/capture/',
      method: 'POST',
      skillName: 'posthog',
      replaceSecretPlaceholders: true,
      json: {
        api_key: '<secret:POSTHOG_PROJECT_TOKEN>',
        event: 'trial_started',
        distinct_id: 'user_123',
        properties: {
          plan: 'pro',
          source: 'checkout',
        },
      },
    },
    costMeasurement: {
      system: 'UsageTotals',
      subLimitKey: 'posthog',
    },
  });
  expect(result.stdout).not.toContain('phx_');
  expect(result.stdout).not.toContain('phc_');
});

test('PostHog helper emits person-property update as guarded identify event', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'identify-person',
    '--distinct-id',
    'user_123',
    '--set-json',
    '{"company":"Acme GmbH","plan":"pro"}',
    '--operator-grant',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    operation: 'identify-person',
    stakesTier: 'amber',
    httpRequest: {
      url: '<env:POSTHOG_INGEST_HOST>/capture/',
      method: 'POST',
      json: {
        api_key: '<secret:POSTHOG_PROJECT_TOKEN>',
        event: '$identify',
        distinct_id: 'user_123',
        properties: {
          $set: {
            company: 'Acme GmbH',
            plan: 'pro',
          },
        },
      },
    },
  });
});

test('PostHog helper emits private persons and feature flag read requests', () => {
  const persons = runHelper([
    '--format',
    'json',
    'http-request',
    'list-persons',
    '--environment-id',
    '123',
    '--search',
    'acme',
    '--limit',
    '50',
  ]);
  const flag = runHelper([
    '--format',
    'json',
    '--host',
    'https://eu.posthog.com',
    '--project-id',
    '456',
    'http-request',
    'get-feature-flag',
    '--flag-id',
    '42',
  ]);

  expect(persons.status).toBe(0);
  expect(flag.status).toBe(0);
  const personsPayload = JSON.parse(persons.stdout);
  expect(personsPayload.httpRequest).toMatchObject({
    url: '<env:POSTHOG_HOST>/api/environments/123/persons/?limit=50&search=acme',
    method: 'GET',
    bearerSecretName: 'POSTHOG_PERSONAL_API_KEY',
    skillName: 'posthog',
  });
  const flagPayload = JSON.parse(flag.stdout);
  expect(flagPayload.httpRequest).toMatchObject({
    url: 'https://eu.posthog.com/api/projects/456/feature_flags/42/',
    method: 'GET',
    bearerSecretName: 'POSTHOG_PERSONAL_API_KEY',
    skillName: 'posthog',
  });
});

test('PostHog helper validates pagination bounds', () => {
  const tooLarge = runHelper([
    '--format',
    'json',
    'http-request',
    'list-feature-flags',
    '--limit',
    '501',
  ]);
  const notInteger = runHelper([
    '--format',
    'json',
    'http-request',
    'list-persons',
    '--limit',
    '25.5',
  ]);

  expect(tooLarge.status).not.toBe(0);
  expect(tooLarge.stderr).toContain('--limit must be between 1 and 500.');
  expect(notInteger.status).not.toBe(0);
  expect(notInteger.stderr).toContain(
    '--limit must be an integer between 1 and 500.',
  );
});

test('PostHog helper emits feature flag test and HogQL query requests', () => {
  const testFlag = runHelper([
    '--format',
    'json',
    'http-request',
    'test-feature-flag',
    '--flag-id',
    '42',
    '--distinct-id',
    'user_123',
  ]);
  const query = runHelper([
    '--format',
    'json',
    'http-request',
    'query',
    '--hogql',
    'select event, count() from events group by event limit 10',
  ]);

  expect(testFlag.status).toBe(0);
  expect(query.status).toBe(0);
  expect(JSON.parse(testFlag.stdout)).toMatchObject({
    operation: 'test-feature-flag',
    stakesTier: 'green',
    httpRequest: {
      url: '<env:POSTHOG_HOST>/api/projects/<env:POSTHOG_PROJECT_ID>/feature_flags/42/test/',
      method: 'POST',
      bearerSecretName: 'POSTHOG_PERSONAL_API_KEY',
      json: {
        distinct_id: 'user_123',
      },
    },
  });
  expect(JSON.parse(query.stdout)).toMatchObject({
    operation: 'query',
    stakesTier: 'green',
    httpRequest: {
      url: '<env:POSTHOG_HOST>/api/projects/<env:POSTHOG_PROJECT_ID>/query/',
      method: 'POST',
      bearerSecretName: 'POSTHOG_PERSONAL_API_KEY',
      json: {
        query: {
          kind: 'HogQLQuery',
          query: 'select event, count() from events group by event limit 10',
        },
      },
    },
  });
});

test('PostHog helper builds approval plans for guarded writes', () => {
  const result = runHelper([
    '--format',
    'json',
    'approval-plan',
    'capture-event',
    '--event',
    'trial_started',
    '--distinct-id',
    'user_123',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'approval-plan',
    operation: 'capture-event',
    stakesTier: 'amber',
    requiredGrant: 'approve-posthog-event-capture',
  });
  expect(payload.approvedCommand).toContain('--operator-grant');
});

test('PostHog helper classifies saved errors', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-error-'));
  const payloadPath = path.join(tempDir, 'error.json');
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({ status: 403, body: 'Forbidden: missing scope' }),
  );
  const result = runHelper([
    '--format',
    'json',
    'explain-error',
    '--payload-file',
    payloadPath,
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: 'explain-error',
    category: 'authorization',
    status: 403,
  });
});

test('PostHog helper classifies missing credential errors', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-error-'));
  const payloadPath = path.join(tempDir, 'missing-secret.json');
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({
      status: 400,
      error: 'Stored secret POSTHOG_PERSONAL_API_KEY is not set.',
    }),
  );
  const result = runHelper([
    '--format',
    'json',
    'explain-error',
    '--payload-file',
    payloadPath,
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: 'explain-error',
    category: 'missing-secret',
    status: 400,
    operatorMessage: expect.stringContaining('/secret set'),
  });
});
