import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const skillDir = path.join(process.cwd(), 'skills', 'langfuse');
const helperPath = path.join(skillDir, 'langfuse.cjs');
const skillPath = path.join(skillDir, 'SKILL.md');

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], { encoding: 'utf-8' });
}

function build(args: string[]) {
  const result = runHelper(['--format', 'json', 'http-request', ...args]);
  return result;
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

test('langfuse manifest declares Basic auth credential, host config, and tiers', () => {
  const raw = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(raw, { name: 'langfuse' });

  expect(manifest.credentials).toEqual([
    expect.objectContaining({
      id: 'langfuse-basic-auth',
      kind: 'header',
      required: true,
      secretRef: { source: 'store', id: 'LANGFUSE_BASIC_AUTH' },
    }),
  ]);
  expect(manifest.configVariables).toEqual([
    expect.objectContaining({
      id: 'langfuse-host',
      env: 'LANGFUSE_HOST',
      required: true,
    }),
  ]);

  expect(raw).toContain('name: langfuse');
  expect(raw).toContain('category: observability');
  expect(raw).toContain('stakes_tiers:');
  expect(raw).toContain('confirm-each');
  expect(raw).toContain('UsageTotals');
  expect(raw).toContain('references/operator-setup.md');
  expect(raw).toContain('Authorization: Basic');
  expect(raw).toContain('/secret set LANGFUSE_BASIC_AUTH');
  expect(raw).toContain('/env set LANGFUSE_HOST');
  // Adapted from the official Langfuse skill (attribution) + docs lookup retained.
  expect(raw).toContain('github.com/langfuse/skills');
  expect(raw).toContain('llms.txt');

  const operatorSetup = fs.readFileSync(
    path.join(skillDir, 'references', 'operator-setup.md'),
    'utf-8',
  );
  expect(operatorSetup).toContain('Recommended Autonomy');
  expect(operatorSetup).toContain('confirm-each');
  expect(operatorSetup).toContain('https://us.cloud.langfuse.com');
});

test('langfuse vendors official references with MIT attribution', () => {
  for (const ref of [
    'instrumentation.md',
    'prompt-migration.md',
    'user-feedback.md',
    'error-analysis.md',
    'judge-calibration.md',
    'sdk-upgrade.md',
    'ci-cd.md',
    'cli.md',
    'skill-feedback.md',
    'operator-setup.md',
  ]) {
    expect(fs.existsSync(path.join(skillDir, 'references', ref))).toBe(true);
  }
  const notice = fs.readFileSync(path.join(skillDir, 'NOTICE.md'), 'utf-8');
  expect(notice).toContain('github.com/langfuse/skills');
  expect(notice).toContain('MIT License');
  // HybridClaw banner redirects the CLI/credential path to the gateway helper.
  const cli = fs.readFileSync(path.join(skillDir, 'references', 'cli.md'), 'utf-8');
  expect(cli).toContain('HybridClaw note');
  expect(cli).toContain('langfuse.cjs');
});

test('langfuse helper enforces the 100 page-size cap and forwards cursor', () => {
  const overLimit = build(['list-traces', '--limit', '250']);
  expect(overLimit.status).not.toBe(0);
  expect(overLimit.stderr).toContain('cannot exceed 100');

  const cursored = build(['list-observations', '--limit', '100', '--cursor', 'abc']);
  expect(cursored.status).toBe(0);
  expect(JSON.parse(cursored.stdout).httpRequest.url).toBe(
    '<env:LANGFUSE_HOST>/api/public/observations?limit=100&cursor=abc',
  );
});

test('langfuse helper --help lists read and write surfaces', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Langfuse skill helper');
  for (const expected of [
    'list-traces',
    'get-prompt',
    'metrics',
    'create-score',
    'create-prompt',
    '--operator-grant',
  ]) {
    expect(result.stdout).toContain(expected);
  }
});

test('langfuse helper runs when copied as a standalone skill package', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'langfuse-skill-'));
  try {
    const packaged = path.join(tempRoot, 'langfuse');
    fs.cpSync(skillDir, packaged, { recursive: true });
    const result = spawnSync(
      'node',
      [path.join(packaged, 'langfuse.cjs'), '--format', 'json', 'plan', 'show recent traces'],
      { encoding: 'utf-8' },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'plan',
      operation: 'list-traces',
      stakesTier: 'green',
      costMeasurement: { system: 'UsageTotals' },
    });
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test('langfuse helper builds gateway-backed reads with placeholder auth and host', () => {
  const traces = build(['list-traces', '--user-id', 'alice', '--limit', '50']);
  const prompt = build([
    'get-prompt',
    '--host',
    'https://us.cloud.langfuse.com',
    '--prompt-name',
    'team/support reply',
    '--label',
    'production',
  ]);

  expect(traces.status).toBe(0);
  const tracesPayload = JSON.parse(traces.stdout);
  expect(tracesPayload).toMatchObject({
    operation: 'list-traces',
    stakesTier: 'green',
    httpRequest: {
      url: '<env:LANGFUSE_HOST>/api/public/traces?limit=50&userId=alice',
      method: 'GET',
      headers: { Authorization: 'Basic <secret:LANGFUSE_BASIC_AUTH>' },
      skillName: 'langfuse',
      stakesTier: 'green',
    },
    liveExecution: {
      requiresConfiguredSecrets: ['LANGFUSE_BASIC_AUTH'],
      callPolicy: expect.stringContaining('CJS helper as the API wrapper'),
      requestShape: expect.stringContaining('Do not handcraft'),
      unauthorizedPolicy: expect.stringContaining('stop after the first failure'),
    },
  });
  expect(tracesPayload.httpRequest).not.toHaveProperty('bearerSecretName');
  expect(tracesPayload.httpRequest).not.toHaveProperty('secretHeaders');
  expect(traces.stdout).not.toContain('Bearer');

  expect(prompt.status).toBe(0);
  expect(JSON.parse(prompt.stdout).httpRequest.url).toBe(
    'https://us.cloud.langfuse.com/api/public/v2/prompts/team%2Fsupport%20reply?label=production',
  );
});

test('langfuse helper forwards metrics query and rejects invalid JSON', () => {
  const ok = build(['metrics', '--query', '{"view":"traces","metrics":[{"measure":"count","aggregation":"count"}]}']);
  expect(ok.status).toBe(0);
  expect(JSON.parse(ok.stdout).httpRequest.url).toBe(
    '<env:LANGFUSE_HOST>/api/public/metrics?query=%7B%22view%22%3A%22traces%22%2C%22metrics%22%3A%5B%7B%22measure%22%3A%22count%22%2C%22aggregation%22%3A%22count%22%7D%5D%7D',
  );

  const bad = build(['metrics', '--query', 'not-json']);
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain('--query must be valid JSON');
});

test('langfuse helper guards writes behind an operator grant', () => {
  const denied = build(['create-score', '--trace-id', 't1', '--name', 'quality', '--value', '0.8']);
  expect(denied.status).not.toBe(0);
  expect(denied.stderr).toContain('--operator-grant');

  const granted = build([
    'create-score',
    '--trace-id',
    't1',
    '--name',
    'quality',
    '--value',
    '0.8',
    '--data-type',
    'NUMERIC',
    '--comment',
    'reviewed',
    '--operator-grant',
  ]);
  expect(granted.status).toBe(0);
  expect(JSON.parse(granted.stdout)).toMatchObject({
    operation: 'create-score',
    stakesTier: 'amber',
    httpRequest: {
      method: 'POST',
      url: '<env:LANGFUSE_HOST>/api/public/scores',
      headers: { Authorization: 'Basic <secret:LANGFUSE_BASIC_AUTH>' },
      json: {
        name: 'quality',
        dataType: 'NUMERIC',
        value: 0.8,
        traceId: 't1',
        comment: 'reviewed',
      },
    },
  });

  const datasetItem = build([
    'create-dataset-item',
    '--dataset-name',
    'regressions',
    '--input-json',
    '{"q":"hi"}',
    '--expected-output-json',
    '{"a":"hello"}',
    '--source-trace-id',
    't1',
    '--operator-grant',
  ]);
  expect(datasetItem.status).toBe(0);
  expect(JSON.parse(datasetItem.stdout).httpRequest.json).toEqual({
    datasetName: 'regressions',
    input: { q: 'hi' },
    expectedOutput: { a: 'hello' },
    sourceTraceId: 't1',
  });

  const chatPromptMissingJson = build([
    'create-prompt',
    '--type',
    'chat',
    '--name',
    'router',
    '--operator-grant',
  ]);
  expect(chatPromptMissingJson.status).not.toBe(0);
  expect(chatPromptMissingJson.stderr).toContain('--prompt-json');
});

test('langfuse helper rejects unknown operations and stray flags', () => {
  const unknownOp = build(['delete-everything']);
  expect(unknownOp.status).not.toBe(0);
  expect(unknownOp.stderr).toContain('Unknown Langfuse operation');
  expect(unknownOp.stderr).not.toContain('--operator-grant');

  const strayFlag = build(['list-traces', '--nope', 'x']);
  expect(strayFlag.status).not.toBe(0);
  expect(strayFlag.stderr).toContain('Unexpected arguments: --nope x');
});

test('langfuse plan classifier routes representative prompts', () => {
  const cases = [
    { prompt: 'Average eval score this week', operation: 'list-scores', tier: 'green' },
    { prompt: 'Record a quality score on this trace', operation: 'create-score', tier: 'amber' },
    { prompt: 'Publish a new version of the summarizer prompt', operation: 'create-prompt', tier: 'amber' },
    { prompt: 'Show daily trace volume metrics', operation: 'metrics', tier: 'green' },
    { prompt: 'List the conversation sessions', operation: 'list-sessions', tier: 'green' },
  ];

  for (const testCase of cases) {
    const result = runHelper(['--format', 'json', 'plan', testCase.prompt]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: testCase.operation,
      stakesTier: testCase.tier,
      costMeasurement: { system: 'UsageTotals' },
    });
  }
});

test('langfuse helper run executes requests through the gateway', async () => {
  let receivedBody: Record<string, unknown> | null = null;
  let receivedAuthorization = '';
  const server = http.createServer((req, res) => {
    receivedAuthorization = String(req.headers.authorization || '');
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      receivedBody = raw ? JSON.parse(raw) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 200, json: { data: [] } }));
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
      'list-traces',
      '--user-id',
      'alice',
      '--gateway-url',
      `http://127.0.0.1:${address.port}`,
      '--gateway-token',
      'gateway-token',
    ]);

    expect(result.status).toBe(0);
    expect(receivedAuthorization).toBe('Bearer gateway-token');
    expect(receivedBody).toMatchObject({
      url: '<env:LANGFUSE_HOST>/api/public/traces?userId=alice',
      method: 'GET',
      headers: { Authorization: 'Basic <secret:LANGFUSE_BASIC_AUTH>' },
      skillName: 'langfuse',
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'run',
      operation: 'list-traces',
      response: { ok: true, status: 200, json: { data: [] } },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('langfuse eval suite covers 10 UsageTotals scenarios', () => {
  const scenarios = JSON.parse(
    fs.readFileSync(path.join(skillDir, 'evals', 'scenarios.json'), 'utf-8'),
  ) as Array<{ costMeasurement?: { system?: string } }>;

  expect(scenarios).toHaveLength(10);
  expect(scenarios.every((s) => s.costMeasurement?.system === 'UsageTotals')).toBe(true);

  const result = runHelper(['--format', 'json', 'eval-scenarios']);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    scenarioCount: 10,
    failed: 0,
    costMeasurement: { system: 'UsageTotals' },
  });
});
