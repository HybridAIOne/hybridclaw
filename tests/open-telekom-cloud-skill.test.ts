import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { expect, test } from 'vitest';

const skillRoot = path.join(process.cwd(), 'skills', 'open-telekom-cloud');
const helperPath = path.join(skillRoot, 'open_telekom_cloud.cjs');

function runHelper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function runHelperAsync(
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [helperPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test('T Cloud Public skill manifest declares infrastructure metadata and SecretRefs', () => {
  const raw = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf-8');

  expect(raw).toContain('name: t-cloud-public');
  expect(raw).toContain('category: infrastructure');
  expect(raw).toContain('OTC_ACCESS_KEY_ID');
  expect(raw).toContain('OTC_SECRET_ACCESS_KEY');
  expect(raw).toContain('OTC_PROJECT_ID');
  expect(raw).toContain('OTC_ENTERPRISE_DASHBOARD_TOKEN');
  expect(raw).toContain('stakes_tiers:');
  expect(raw).toContain('confirm-each');
  expect(raw).toContain('UsageTotals');
  expect(raw).toContain('references/operator-setup.md');
  expect(raw).toContain('Terraform/OpenTofu');
  expect(raw).toContain('Cloud Create');

  const operatorSetup = fs.readFileSync(
    path.join(skillRoot, 'references', 'operator-setup.md'),
    'utf-8',
  );
  expect(operatorSetup).toContain('Recommended Autonomy');
  expect(operatorSetup).toContain('confirm-each');
  expect(operatorSetup).toContain('OTC_SECURITY_TOKEN');
  expect(operatorSetup).toContain('api-enterprise-dashboard.otc-service.com');
});

test('T Cloud Public helper exposes expected commands', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  for (const expected of [
    'regions',
    'service-endpoints',
    'service-status',
    'quotas',
    'servers',
    'networks',
    'volumes',
    'cloud-eye-alarms',
    'rds-instances',
    'kms-keys',
    'billing-daily-consumption',
    'billing-hourly-consumption',
  ]) {
    expect(result.stdout).toContain(expected);
  }
});

test('T Cloud Public helper builds allowlisted signed read payloads', () => {
  const servers = runHelper([
    '--format',
    'json',
    'http-request',
    'servers',
    '--region',
    'eu-de',
    '--project-id',
    'project123',
    '--limit',
    '50',
    '--status',
    'ACTIVE',
  ]);
  const networks = runHelper([
    '--format',
    'json',
    'http-request',
    'networks',
    '--region',
    'eu-de',
    '--project-id',
    'project123',
    '--limit',
    '50',
  ]);
  const volumes = runHelper([
    '--format',
    'json',
    'http-request',
    'volumes',
    '--region',
    'eu-de',
    '--project-id',
    'project123',
    '--limit',
    '50',
  ]);
  const alarms = runHelper([
    '--format',
    'json',
    'http-request',
    'cloud-eye-alarms',
    '--region',
    'eu-de',
    '--project-id',
    'project123',
    '--limit',
    '50',
  ]);
  const serviceEndpoints = runHelper([
    '--format',
    'json',
    'http-request',
    'service-endpoints',
    '--region',
    'eu-de',
    '--interface',
    'public',
    '--enabled',
    'true',
  ]);
  const serviceStatus = runHelper([
    '--format',
    'json',
    'http-request',
    'service-status',
  ]);

  expect(servers.status).toBe(0);
  const payload = JSON.parse(servers.stdout);
  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'servers',
    stakesTier: 'green',
    costMeasurement: { system: 'UsageTotals' },
  });
  expect(payload.httpRequest).toMatchObject({
    method: 'GET',
    url: 'https://ecs.eu-de.otc.t-systems.com/v2.1/project123/servers/detail?limit=50&status=ACTIVE',
    skillName: 't-cloud-public',
    stakesTier: 'green',
    otcAkSk: {
      accessKeyIdSecretName: 'OTC_ACCESS_KEY_ID',
      secretAccessKeySecretName: 'OTC_SECRET_ACCESS_KEY',
    },
  });
  expect(payload.httpRequest).not.toHaveProperty('headers.Authorization');
  expect(payload.liveExecution).toMatchObject({
    requiresConfiguredSecrets: [
      'OTC_ACCESS_KEY_ID',
      'OTC_SECRET_ACCESS_KEY',
      'OTC_PROJECT_ID',
    ],
    optionalConfiguredSecrets: ['OTC_SECURITY_TOKEN'],
    callPolicy: expect.stringContaining('gateway-managed OTC AK/SK signing'),
    secretRefPolicy: expect.stringContaining('otcAkSk'),
    unauthorizedPolicy: expect.stringContaining('stop after the first failure'),
    rateLimitPolicy: expect.stringContaining('429'),
  });
  expect(payload.liveExecution.requiresConfiguredSecrets).not.toContain(
    'OTC_REGION',
  );

  expect(networks.status).toBe(0);
  expect(JSON.parse(networks.stdout).httpRequest.url).toBe(
    'https://vpc.eu-de.otc.t-systems.com/v1/project123/vpcs?limit=50',
  );
  expect(volumes.status).toBe(0);
  expect(JSON.parse(volumes.stdout).httpRequest.url).toBe(
    'https://evs.eu-de.otc.t-systems.com/v2/project123/volumes/detail?limit=50',
  );
  expect(alarms.status).toBe(0);
  expect(JSON.parse(alarms.stdout).httpRequest.url).toBe(
    'https://ces.eu-de.otc.t-systems.com/V1.0/project123/alarms?limit=50',
  );
  expect(serviceEndpoints.status).toBe(0);
  expect(JSON.parse(serviceEndpoints.stdout).httpRequest).toMatchObject({
    url: 'https://iam.eu-de.otc.t-systems.com/v3/endpoints?interface=public&enabled=true',
    method: 'GET',
    otcAkSk: {
      accessKeyIdSecretName: 'OTC_ACCESS_KEY_ID',
      secretAccessKeySecretName: 'OTC_SECRET_ACCESS_KEY',
    },
  });
  expect(serviceStatus.status).toBe(0);
  expect(JSON.parse(serviceStatus.stdout).httpRequest).toMatchObject({
    url: 'https://status.otc-service.com/',
    method: 'GET',
    skillName: 't-cloud-public',
  });
  expect(JSON.parse(serviceStatus.stdout).httpRequest).not.toHaveProperty(
    'otcAkSk',
  );
  expect(JSON.parse(serviceStatus.stdout).liveExecution).toMatchObject({
    requiresConfiguredSecrets: [],
  });
});

test('T Cloud Public helper builds Enterprise Dashboard billing payloads', () => {
  const daily = runHelper([
    '--format',
    'json',
    'http-request',
    'billing-daily-consumption',
    '--date',
    '2026-05-24',
    '--project-name',
    'eu-de',
    '--consumption-type',
    'EL',
  ]);
  const hourly = runHelper([
    '--format',
    'json',
    'http-request',
    'billing-hourly-consumption',
    '--date',
    '2026-05-24',
    '--hour',
    '13',
    '--enterprise-dashboard-token-secret',
    'OTC_ED_TOKEN',
  ]);

  expect(daily.status).toBe(0);
  expect(JSON.parse(daily.stdout)).toMatchObject({
    command: 'http-request',
    operation: 'billing-daily-consumption',
    stakesTier: 'amber',
    httpRequest: {
      method: 'GET',
      url: 'https://api-enterprise-dashboard.otc-service.com/v2/daily/consumption/?consumption_type=EL&date=2026-05-24&project_name=eu-de',
      skillName: 't-cloud-public',
      stakesTier: 'amber',
      bearerSecretName: 'OTC_ENTERPRISE_DASHBOARD_TOKEN',
      headers: {
        'Content-Type': 'application/x-ndjson',
      },
    },
    liveExecution: {
      mode: 'live-t-cloud-public-enterprise-dashboard-api',
      requiresConfiguredSecrets: ['OTC_ENTERPRISE_DASHBOARD_TOKEN'],
      callPolicy: expect.stringContaining('Enterprise Dashboard billing reads'),
      secretRefPolicy: expect.stringContaining(
        'OTC_ENTERPRISE_DASHBOARD_TOKEN',
      ),
      requestShape: expect.stringContaining('NDJSON'),
    },
  });
  expect(JSON.parse(daily.stdout).httpRequest).not.toHaveProperty('otcAkSk');
  expect(hourly.status).toBe(0);
  expect(JSON.parse(hourly.stdout).httpRequest).toMatchObject({
    url: 'https://api-enterprise-dashboard.otc-service.com/v2/hourly/consumption/?date=2026-05-24&hour=13',
    bearerSecretName: 'OTC_ED_TOKEN',
  });
});

test('T Cloud Public helper keeps project IDs and signing material secret-backed by default', () => {
  const result = runHelper(
    ['--format', 'json', 'http-request', 'servers', '--region', 'eu-de'],
    {
      OTC_ACCESS_KEY_ID: 'clear-ak',
      OTC_SECRET_ACCESS_KEY: 'clear-sk',
      OTC_PROJECT_ID: '',
    },
  );

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('<secret:OTC_PROJECT_ID>');
  expect(result.stdout).toContain('OTC_ACCESS_KEY_ID');
  expect(result.stdout).toContain('OTC_SECRET_ACCESS_KEY');
  expect(result.stdout).not.toContain('clear-ak');
  expect(result.stdout).not.toContain('clear-sk');
  expect(result.stdout).not.toContain('Authorization');
});

test('T Cloud Public helper rejects invalid region and limit bounds', () => {
  const badRegion = runHelper([
    '--format',
    'json',
    'http-request',
    'servers',
    '--region',
    'not_a_region!!',
  ]);
  const badLimit = runHelper([
    '--format',
    'json',
    'http-request',
    'servers',
    '--region',
    'eu-de',
    '--limit',
    '99999',
  ]);

  expect(badRegion.status).toBe(2);
  expect(badRegion.stderr).toContain('Invalid OTC region');
  expect(badLimit.status).toBe(2);
  expect(badLimit.stderr).toContain('--limit must be between 1 and 1000');
});

test('T Cloud Public helper rejects arbitrary endpoints and plans mutations as red', () => {
  const unknown = runHelper([
    '--format',
    'json',
    'http-request',
    'arbitrary-service-path',
  ]);
  const mutation = runHelper([
    '--format',
    'json',
    'plan',
    'delete production server srv-123',
    '--region',
    'eu-de',
  ]);

  expect(unknown.status).not.toBe(0);
  expect(unknown.stderr).toContain(
    'Unknown T Cloud Public / Open Telekom Cloud operation',
  );
  expect(mutation.status).toBe(0);
  expect(JSON.parse(mutation.stdout)).toMatchObject({
    command: 'plan',
    operation: 'guarded-mutation-request',
    stakesTier: 'red',
    requiresEscalation: true,
    requiredGrant: 'approve-t-cloud-public-exact-f8-f14-mutation',
  });
});

test('T Cloud Public helper plans account billing through Enterprise Dashboard', () => {
  const billing = runHelper([
    '--format',
    'json',
    'plan',
    'show billing charges and orders for this account',
    '--region',
    'eu-de',
  ]);

  expect(billing.status).toBe(0);
  const payload = JSON.parse(billing.stdout);
  expect(payload).toMatchObject({
    command: 'plan',
    operation: 'billing-daily-consumption',
    stakesTier: 'amber',
    requiresEscalation: false,
    requiredGrant: null,
  });
  expect(payload.nextStep).toContain('http-request billing-daily-consumption');
  expect(payload.nextStep).toContain('Enterprise Dashboard API');
});

test('T Cloud Public helper treats current cost prompts as Enterprise Dashboard billing', () => {
  const costToday = runHelper([
    '--format',
    'json',
    'plan',
    'Can you show how much cost have been caused today?',
    '--region',
    'eu-de',
  ]);
  const germanCost = runHelper([
    '--format',
    'json',
    'plan',
    'Zeig mir die Kosten und Rechnungen von heute.',
    '--region',
    'eu-de',
  ]);

  expect(costToday.status).toBe(0);
  expect(germanCost.status).toBe(0);
  for (const result of [costToday, germanCost]) {
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      command: 'plan',
      operation: 'billing-daily-consumption',
      stakesTier: 'amber',
    });
    expect(payload.nextStep).toContain('parse NDJSON rows');
    expect(payload.nextStep).toContain('sum amount fields');
  }
  const hourly = runHelper([
    '--format',
    'json',
    'plan',
    'Show hourly billing cost today',
    '--region',
    'eu-de',
  ]);
  expect(JSON.parse(hourly.stdout)).toMatchObject({
    operation: 'billing-hourly-consumption',
    stakesTier: 'amber',
  });
});

test('T Cloud Public helper summarizes Enterprise Dashboard NDJSON billing responses', async () => {
  const receivedBodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      receivedBodies.push(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          status: 200,
          body: [
            JSON.stringify({
              amount: 1.25,
              product_description: 'Elastic Cloud Server',
            }),
            JSON.stringify({
              amount: 0.75,
              product_description: 'Elastic Cloud Server',
            }),
            JSON.stringify({
              amount: 0.5,
              product: 'OTC_EVS',
            }),
            'not-json',
          ].join('\n'),
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP test server address.');
    }
    const result = await runHelperAsync([
      '--format',
      'json',
      'run',
      'billing-daily-consumption',
      '--date',
      '2026-05-24',
      '--gateway-url',
      `http://127.0.0.1:${address.port}`,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'run',
      operation: 'billing-daily-consumption',
      stakesTier: 'amber',
      billingSummary: {
        rowCount: 3,
        amountTotal: 2.5,
        skippedRows: 1,
        products: {
          'Elastic Cloud Server': 2,
          OTC_EVS: 0.5,
        },
      },
    });
    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]).toMatchObject({
      skillName: 't-cloud-public',
      bearerSecretName: 'OTC_ENTERPRISE_DASHBOARD_TOKEN',
    });
    expect(receivedBodies[0]).not.toHaveProperty('otcAkSk');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('T Cloud Public helper run posts to gateway and summarizes auth and rate-limit failures', async () => {
  const receivedBodies: Record<string, unknown>[] = [];
  let mode: 'auth' | 'rate-limit' = 'auth';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      receivedBodies.push(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'auth') {
        res.end(
          JSON.stringify({
            ok: false,
            status: 403,
            body: 'signature mismatch',
            headers: {},
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          ok: false,
          status: 429,
          body: 'rate limited',
          headers: { 'retry-after': '30' },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP test server address.');
    }
    const authResult = await runHelperAsync([
      '--format',
      'json',
      'run',
      'servers',
      '--region',
      'eu-de',
      '--project-id',
      'project123',
      '--gateway-url',
      `http://127.0.0.1:${address.port}`,
    ]);
    mode = 'rate-limit';
    const rateLimitResult = await runHelperAsync([
      '--format',
      'json',
      'run',
      'cloud-eye-alarms',
      '--region',
      'eu-de',
      '--project-id',
      'project123',
      '--gateway-url',
      `http://127.0.0.1:${address.port}`,
    ]);

    expect(authResult.status).toBe(0);
    const authPayload = JSON.parse(authResult.stdout);
    expect(authPayload).toMatchObject({
      command: 'run',
      operation: 'servers',
      responseSummary: {
        credentialProblem: true,
        rateLimited: false,
        guidance: expect.stringContaining('Stop after this failed OTC call'),
      },
    });
    expect(authPayload.responseSummary.guidance).not.toContain('OTC_REGION');
    expect(rateLimitResult.status).toBe(0);
    expect(JSON.parse(rateLimitResult.stdout)).toMatchObject({
      command: 'run',
      operation: 'cloud-eye-alarms',
      responseSummary: {
        credentialProblem: false,
        rateLimited: true,
        retryAfter: '30',
      },
    });
    expect(receivedBodies).toHaveLength(2);
    expect(receivedBodies[0]).toMatchObject({
      skillName: 't-cloud-public',
      otcAkSk: {
        accessKeyIdSecretName: 'OTC_ACCESS_KEY_ID',
        secretAccessKeySecretName: 'OTC_SECRET_ACCESS_KEY',
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
