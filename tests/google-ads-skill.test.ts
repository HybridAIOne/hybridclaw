import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { expect, test } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'google-ads',
  'scripts',
  'google_ads.py',
);
const scenariosPath = path.join(
  process.cwd(),
  'skills',
  'google-ads',
  'evals',
  'scenarios.json',
);
const skillPath = path.join(process.cwd(), 'skills', 'google-ads', 'SKILL.md');

function runHelper(args: string[]) {
  return spawnSync('python3', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

function runHelperAsync(args: string[], timeoutMs = 10_000) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn('python3', [helperPath, ...args], {
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finishResolve = (status: number | null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve({ status, stdout, stderr });
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        reject(error);
      };
      timeout = setTimeout(() => {
        child.kill();
        finishReject(
          new Error(`Timed out after ${timeoutMs}ms waiting for Google Ads helper`),
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
      child.on('error', finishReject);
      child.on('close', finishResolve);
    },
  );
}

test('Google Ads skill manifest declares marketing category and safety metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: google-ads');
  expect(skill).toContain('category: marketing');
  expect(skill).toContain('stakes_tiers:');
  expect(skill).toContain('budget-mutation');
  expect(skill).toContain('customer-match-upload');
  expect(skill).toContain('brand-voice');
  expect(skill).toContain('UsageTotals');
});

test('Google Ads helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Google Ads GAQL reporting');
  expect(result.stdout).toContain('customers');
  expect(result.stdout).toContain('gaql');
  expect(result.stdout).toContain('report-plan');
  expect(result.stdout).toContain('eval-scenarios');
});

test('Google Ads helper plans English and German GAQL reports offline', () => {
  const result = runHelper([
    '--format',
    'json',
    'report-plan',
    'Show me the worst-performing ad groups in the German campaigns this week below 1% CTR',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.stakesTier).toBe('green');
  expect(payload.requiresEscalation).toBe(false);
  expect(payload.query).toContain('FROM ad_group');
  expect(payload.query).toContain('segments.date DURING THIS_WEEK');
  expect(payload.query).toContain("campaign.name LIKE '%DE%'");
  expect(payload.query).toContain('metrics.ctr < 0.01');
  expect(payload.review.allowed).toBe(true);
  expect(payload.costMeasurement.system).toBe('UsageTotals');
});

test('Google Ads helper blocks unsafe GAQL before execution', () => {
  const result = runHelper([
    '--format',
    'json',
    'review-gaql',
    'DELETE FROM campaign WHERE campaign.id = 123',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.review.allowed).toBe(false);
  expect(payload.review.findings).toContain('GAQL must start with SELECT.');
  expect(payload.review.findings).toContain('GAQL reports must be read-only.');
});

test('Google Ads helper classifies spend and PII operations as red-tier', () => {
  const budget = runHelper([
    '--format',
    'json',
    'plan',
    'Bump the daily budget on campaign X by 20%',
  ]);
  const upload = runHelper([
    '--format',
    'json',
    'plan',
    'Upload this customer match list of email hashes',
  ]);

  expect(budget.status).toBe(0);
  expect(upload.status).toBe(0);
  const budgetPayload = JSON.parse(budget.stdout);
  const uploadPayload = JSON.parse(upload.stdout);
  expect(budgetPayload).toMatchObject({
    operation: 'budget-or-bid-strategy-mutation',
    stakesTier: 'red',
    requiresEscalation: true,
    requiredGrant: 'approve-google-ads-budget-or-bid-change',
  });
  expect(uploadPayload).toMatchObject({
    operation: 'customer-match-upload',
    stakesTier: 'red',
    requiresEscalation: true,
    requiredGrant: 'approve-google-ads-customer-match-upload',
  });
});

test('Google Ads helper requires brand-voice gate for ad copy', () => {
  const result = runHelper([
    '--format',
    'json',
    'ad-copy-review',
    '--headline',
    'Fast CRM Migration',
    '--description',
    'Switch cleanly with expert migration planning',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.stakesTier).toBe('red');
  expect(payload.requiresEscalation).toBe(true);
  expect(payload.brandVoiceGateRequired).toBe(true);
  expect(payload.requiredGrant).toBe('approve-google-ads-ad-copy-submit');
  expect(payload.preflight.allowed).toBe(true);
});

test('Google Ads helper refuses live mutations without the exact grant', () => {
  const result = runHelper([
    '--format',
    'json',
    'campaign-status',
    '1234567890',
    '111222333',
    '--status',
    'PAUSED',
  ]);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain(
    'expected explicit grant `approve-google-ads-campaign-state-change`',
  );
});

test('Google Ads helper eval suite covers required launch scenarios', () => {
  const scenarios = JSON.parse(fs.readFileSync(scenariosPath, 'utf-8')) as Array<{
    category?: string;
    expected?: { costSystem?: string };
  }>;
  const categories = new Set(scenarios.map((scenario) => scenario.category));

  expect(scenarios).toHaveLength(30);
  expect(categories).toEqual(
    new Set([
      'reporting',
      'recommendations',
      'campaign-edit',
      'high-stakes-refusal',
      'ad-authoring',
      'audience-management',
      'conversion-tracking',
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
  expect(payload.scenarioCount).toBe(30);
  expect(payload.failed).toBe(0);
  expect(payload.categories).toMatchObject({
    reporting: 8,
    'high-stakes-refusal': 8,
    'ad-authoring': 4,
  });
  expect(payload.stakesTiers).toMatchObject({
    green: 8,
    amber: 8,
    red: 11,
    unknown: 3,
  });
});

test('Google Ads helper sends campaign status mutation through gateway after grant', async () => {
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
      res.end(
        JSON.stringify({
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyJson: { results: [{ resourceName: 'customers/1234567890/campaigns/111222333' }] },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address !== 'object') {
      throw new Error('Expected server address.');
    }
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const result = await runHelperAsync([
      '--format',
      'json',
      '--gateway-url',
      gatewayUrl,
      'campaign-status',
      '123-456-7890',
      '111222333',
      '--status',
      'PAUSED',
      '--grant',
      'approve-google-ads-campaign-state-change',
      '--validate-only',
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.operationKey).toBe('campaign-state-mutation');
    expect(payload.validateOnly).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      url: 'https://googleads.googleapis.com/v24/customers/1234567890/campaigns:mutate',
      method: 'POST',
      bearerSecretName: 'GOOGLE_WORKSPACE_CLI_TOKEN',
      json: {
        validateOnly: true,
        operations: [
          {
            updateMask: 'status',
            update: {
              resourceName: 'customers/1234567890/campaigns/111222333',
              status: 'PAUSED',
            },
          },
        ],
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Google Ads helper enforces brand voice before RSA submission', () => {
  const result = runHelper([
    '--format',
    'json',
    'rsa-create',
    '1234567890',
    '555666777',
    '--headline',
    'Fast CRM Migration',
    '--headline',
    'Clean Data Move',
    '--headline',
    'Launch With Control',
    '--description',
    'Switch cleanly with expert migration planning',
    '--description',
    'Move your CRM data with a clear rollout plan',
    '--final-url',
    'https://example.com',
    '--grant',
    'approve-google-ads-ad-copy-submit',
  ]);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain('brand-voice gate passes');
});

test('Google Ads helper sends live GAQL through gateway with OAuth and developer-token handles', async () => {
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
      res.end(
        JSON.stringify({
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyJson: [{ results: [{ campaign: { id: '123', name: 'Brand' } }] }],
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address !== 'object') {
      throw new Error('Expected server address.');
    }
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const result = await runHelperAsync([
      '--format',
      'json',
      '--gateway-url',
      gatewayUrl,
      'gaql',
      '123-456-7890',
      'SELECT campaign.id, campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 10',
      '--max-response-bytes',
      '12345',
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.customerId).toBe('1234567890');
    expect(payload.payload.bodyJson[0].results[0].campaign.name).toBe('Brand');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      url: 'https://googleads.googleapis.com/v24/customers/1234567890/googleAds:searchStream',
      method: 'POST',
      bearerSecretName: 'GOOGLE_WORKSPACE_CLI_TOKEN',
      json: {
        query:
          'SELECT campaign.id, campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 10',
      },
      maxResponseBytes: 12345,
      skillName: 'google-ads',
    });
    expect(captured[0]).toMatchObject({
      secretHeaders: [
        {
          name: 'developer-token',
          secretName: 'GOOGLEADS_DEVELOPER_TOKEN',
          prefix: '',
        },
      ],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
