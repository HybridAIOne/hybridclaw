import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { expect, test } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'ga4',
  'scripts',
  'ga4.py',
);
const scenariosPath = path.join(
  process.cwd(),
  'skills',
  'ga4',
  'evals',
  'scenarios.json',
);
const skillPath = path.join(process.cwd(), 'skills', 'ga4', 'SKILL.md');

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
      const timeout = setTimeout(() => {
        child.kill();
        reject(
          new Error(`Timed out after ${timeoutMs}ms waiting for GA4 helper`),
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
      res.end(
        JSON.stringify({
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyJson: {
            rows: [
              {
                dimensionValues: [{ value: '20260511' }],
                metricValues: [{ value: '42' }],
              },
            ],
            rowCount: 1,
          },
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
    await run(`http://127.0.0.1:${address.port}`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GA4 skill manifest declares production reporting scope and auth handles', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: ga4');
  expect(skill).toContain('category: marketing');
  expect(skill).toContain('traffic-source-breakdown');
  expect(skill).toContain('landing-page-breakdown');
  expect(skill).toContain('time-series');
  expect(skill).toContain('UsageTotals');
  expect(skill).toContain('delegated-user OAuth');
  expect(skill).toContain('service-account');
  expect(skill).toContain('bearerSecretName');
  expect(skill).toContain('GOOGLE_WORKSPACE_CLI_TOKEN');
  expect(skill).toContain('GA4_BEARER_SECRET_NAME');
});

test('GA4 helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('GA4 Data API reporting');
  expect(result.stdout).toContain('report-plan');
  expect(result.stdout).toContain('review-request');
  expect(result.stdout).toContain('http-request');
  expect(result.stdout).toContain('metadata-request');
  expect(result.stdout).toContain('run-report');
  expect(result.stdout).toContain('eval-scenarios');
});

test('GA4 helper plans organic key-event comparison reports', () => {
  const result = runHelper([
    '--format',
    'json',
    'report-plan',
    "Show me last week's organic conversions vs the prior week",
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.requiresClarification).toBe(false);
  expect(payload.request.dateRanges).toHaveLength(2);
  expect(payload.request.dimensions).toEqual([
    { name: 'sessionDefaultChannelGroup' },
  ]);
  expect(payload.request.metrics).toEqual([{ name: 'keyEvents' }]);
  expect(payload.request.dimensionFilter).toMatchObject({
    filter: {
      fieldName: 'sessionDefaultChannelGroup',
      stringFilter: { value: 'Organic Search' },
    },
  });
  expect(payload.review.allowed).toBe(true);
  expect(payload.costMeasurement.system).toBe('UsageTotals');
});

test('GA4 helper plans landing-page revenue and session reports', () => {
  const result = runHelper([
    '--format',
    'json',
    'report-plan',
    'Top landing pages by sessions and revenue last month',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.request.dimensions).toContainEqual({
    name: 'landingPagePlusQueryString',
  });
  expect(payload.request.metrics).toEqual([
    { name: 'totalRevenue' },
    { name: 'sessions' },
  ]);
  expect(payload.review.allowed).toBe(true);
});

test('GA4 helper plans time-series sessions by date', () => {
  const result = runHelper([
    '--format',
    'json',
    'report-plan',
    'Daily sessions for the last 30 days',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.request.dimensions).toEqual([{ name: 'date' }]);
  expect(payload.request.metrics).toEqual([{ name: 'sessions' }]);
  expect(payload.request.orderBys).toEqual([
    { dimension: { dimensionName: 'date' } },
  ]);
});

test('GA4 helper requires explicit dates for ambiguous quarter reports', () => {
  const result = runHelper([
    '--format',
    'json',
    'report-plan',
    'What happened to revenue in Q1?',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.requiresClarification).toBe(true);
  expect(payload.review.allowed).toBe(false);
  expect(payload.request).toEqual({});
});

test('GA4 helper blocks unsupported Admin API mutation requests', () => {
  const result = runHelper([
    '--format',
    'json',
    'report-plan',
    'Give the marketing team admin access to the GA4 property',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.requiresClarification).toBe(true);
  expect(payload.review.findings).toContain(
    'Admin or access mutation requested.',
  );
});

test('GA4 helper reviews request JSON before execution', () => {
  const result = runHelper([
    '--format',
    'json',
    'review-request',
    JSON.stringify({
      dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
      dimensions: [{ name: 'unknownDimension' }],
      metrics: [{ name: 'sessions' }],
      limit: 25,
    }),
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.review.allowed).toBe(false);
  expect(payload.review.findings).toContain(
    'Unknown or unsupported GA4 dimension: unknownDimension',
  );
});

test('GA4 helper emits analyst prompt-template payload', () => {
  const result = runHelper([
    '--format',
    'json',
    'prompt-template',
    'Daily sessions and revenue for the last 30 days',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.templateFamily).toBe('R21.5 GA4 analyst query review');
  expect(payload.dialect).toBe('GA4 Data API runReport JSON');
  expect(payload.payload.deterministicReview).toMatchObject({
    allowed: true,
    readOnly: true,
    requiresWriteGrant: false,
  });
  expect(payload.costMeasurement.system).toBe('UsageTotals');
});

test('GA4 helper builds http_request payloads with delegated OAuth handle by default', () => {
  const requestJson = JSON.stringify({
    dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }],
    limit: 25,
  });
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'properties/123456789',
    '--request-json',
    requestJson,
    '--max-response-bytes',
    '12345',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.propertyId).toBe('123456789');
  expect(payload.auth.bearerSecretName).toBe('GOOGLE_WORKSPACE_CLI_TOKEN');
  expect(payload.httpRequest).toMatchObject({
    url: 'https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport',
    method: 'POST',
    bearerSecretName: 'GOOGLE_WORKSPACE_CLI_TOKEN',
    json: JSON.parse(requestJson),
    maxResponseBytes: 12345,
    skillName: 'ga4',
  });
});

test('GA4 helper can select a service-account bearer handle', () => {
  const result = runHelper([
    '--format',
    'json',
    '--bearer-secret-name',
    'GA4_SERVICE_ACCOUNT_ACCESS_TOKEN',
    'metadata-request',
    '123456789',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.auth.bearerSecretName).toBe(
    'GA4_SERVICE_ACCOUNT_ACCESS_TOKEN',
  );
  expect(payload.httpRequest).toMatchObject({
    url: 'https://analyticsdata.googleapis.com/v1beta/properties/123456789/metadata',
    method: 'GET',
    bearerSecretName: 'GA4_SERVICE_ACCOUNT_ACCESS_TOKEN',
    skillName: 'ga4',
  });
});

test('GA4 helper sends live reports through the gateway with bearer handle only', async () => {
  await withMockGateway(async (gatewayUrl, captured) => {
    const result = await runHelperAsync([
      '--format',
      'json',
      '--gateway-url',
      gatewayUrl,
      'run-report',
      '123456789',
      '--request-json',
      JSON.stringify({
        dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }],
        limit: 25,
      }),
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.payload.bodyJson.rows[0].metricValues[0].value).toBe('42');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      url: 'https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport',
      method: 'POST',
      bearerSecretName: 'GOOGLE_WORKSPACE_CLI_TOKEN',
      skillName: 'ga4',
    });
    expect(captured[0]).not.toHaveProperty('secretHeaders');
  });
});

test('GA4 helper refuses unauthenticated remote gateway URLs', () => {
  const result = runHelper([
    '--format',
    'json',
    '--gateway-url',
    'https://gateway.example.com',
    'run-report',
    '123456789',
    '--request-json',
    JSON.stringify({
      dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
      metrics: [{ name: 'sessions' }],
    }),
  ]);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain(
    'Refusing unauthenticated remote gateway URL',
  );
});

test('GA4 helper eval suite covers required analyst scenarios', () => {
  const scenarios = JSON.parse(
    fs.readFileSync(scenariosPath, 'utf-8'),
  ) as Array<{
    category?: string;
    expected?: { costSystem?: string };
  }>;
  const categories = new Set(scenarios.map((scenario) => scenario.category));

  expect(scenarios).toHaveLength(25);
  expect(categories).toEqual(
    new Set([
      'audience',
      'campaign',
      'clarification',
      'comparison',
      'conversion',
      'ecommerce',
      'engagement',
      'landing-page',
      'realtime',
      'revenue',
      'safety',
      'time-series',
      'traffic-source',
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
  expect(payload.scenarioCount).toBe(25);
  expect(payload.failed).toBe(0);
  expect(payload.categories).toMatchObject({
    'traffic-source': 3,
    'landing-page': 2,
    'time-series': 3,
    comparison: 2,
    clarification: 1,
    safety: 1,
  });
});
