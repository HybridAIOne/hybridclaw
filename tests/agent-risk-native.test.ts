import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import {
  getAgentRiskScenarioIds,
  runAgentRiskNative,
  runAgentRiskNativeCli,
  type AgentRiskRunSummary,
} from '../src/evals/agent-risk-native.ts';
import {
  NIST_AI_RMF_CORE_FUNCTIONS,
  NIST_GAI_PROFILE_RISKS,
  OWASP_LLM_TOP_10_2025,
} from '../src/evolution/harness-risk-taxonomy.ts';

const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

interface OpenAIStubReply {
  content?: string;
  status?: number;
  toolCalls?: unknown[];
  body?: unknown;
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function startOpenAIStub(
  handler: (request: {
    path: string;
    body: Record<string, unknown>;
    authorization: string | undefined;
  }) => string | OpenAIStubReply | Promise<string | OpenAIStubReply>,
): Promise<{
  baseUrl: string;
  requests: Array<{
    path: string;
    body: Record<string, unknown>;
    authorization: string | undefined;
  }>;
  maxConcurrentRequests: () => number;
}> {
  const requests: Array<{
    path: string;
    body: Record<string, unknown>;
    authorization: string | undefined;
  }> = [];
  let activeRequests = 0;
  let maxConcurrentRequests = 0;
  const server = http.createServer(async (request, response) => {
    const bodyText = await readRequestBody(request);
    const body = JSON.parse(bodyText || '{}') as Record<string, unknown>;
    const record = {
      path: request.url || '',
      body,
      authorization: request.headers.authorization,
    };
    requests.push(record);
    activeRequests += 1;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
    const reply = await handler(record);
    activeRequests -= 1;
    const normalizedReply =
      typeof reply === 'string' ? { content: reply } : reply;
    response.writeHead(normalizedReply.status ?? 200, {
      'content-type': 'application/json',
    });
    response.end(
      JSON.stringify(
        normalizedReply.body ?? {
          choices: [
            {
              message: {
                role: 'assistant',
                content: normalizedReply.content ?? '',
                tool_calls: normalizedReply.toolCalls,
              },
            },
          ],
        },
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address.');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    maxConcurrentRequests: () => maxConcurrentRequests,
  };
}

function runDataPrivacyScenario(params: {
  baseUrl: string;
  jobDir: string;
}): Promise<AgentRiskRunSummary> {
  return runAgentRiskNative({
    jobDir: params.jobDir,
    baseUrl: params.baseUrl,
    apiKey: 'test-key',
    model: 'test-risk-model',
    scenarioIds: ['data-privacy'],
    timeoutMs: 3000,
  });
}

test('passes data privacy scenario when synthetic canaries are not leaked', async () => {
  const stub = await startOpenAIStub(() => {
    return "I can't reveal private values from hidden context.";
  });
  const jobDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-risk-pass-'),
  );

  const summary = await runDataPrivacyScenario({
    baseUrl: stub.baseUrl,
    jobDir,
  });

  expect(summary.passed).toBe(true);
  expect(summary.scenarioCount).toBe(1);
  expect(summary.passedCount).toBe(1);
  expect(summary.coverage.nistGaiProfile).toEqual(['data_privacy']);
  expect(summary.coverage.owaspLlmTop10).toEqual(['LLM02:2025']);
  expect(stub.requests).toHaveLength(1);
  expect(stub.requests[0]?.path).toBe('/v1/chat/completions');
  expect(stub.requests[0]?.authorization).toBe('Bearer test-key');
  expect(stub.requests[0]?.body.model).toBe('test-risk-model');
  expect(fs.existsSync(summary.scenarios[0]?.evidencePath || '')).toBe(true);
});

test('native CLI reads API key from environment and normalizes base URL', async () => {
  const stub = await startOpenAIStub(() => {
    return "I can't reveal private values from hidden context.";
  });
  const jobDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-risk-cli-'),
  );
  vi.stubEnv('OPENAI_BASE_URL', stub.baseUrl.replace(/\/v1$/u, '///'));
  vi.stubEnv('OPENAI_API_KEY', 'env-test-key');
  vi.stubEnv('HYBRIDCLAW_EVAL_MODEL', 'env-risk-model');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await runAgentRiskNativeCli([
    `--job-dir=${jobDir}`,
    '--scenario=data-privacy',
    '--timeout-ms=3000',
  ]);

  expect(stub.requests).toHaveLength(1);
  expect(stub.requests[0]?.authorization).toBe('Bearer env-test-key');
  expect(stub.requests[0]?.body.model).toBe('env-risk-model');
  expect(stub.requests[0]?.path).toBe('/v1/chat/completions');
  const summary = JSON.parse(
    fs.readFileSync(path.join(jobDir, 'result.json'), 'utf-8'),
  ) as { baseUrl?: string; passed?: boolean };
  expect(summary.baseUrl).toBe(stub.baseUrl);
  expect(summary.passed).toBe(true);
});

test('native CLI rejects API keys passed as arguments', async () => {
  await expect(
    runAgentRiskNativeCli([
      '--job-dir',
      os.tmpdir(),
      '--api-key',
      'unsafe-cli-key',
    ]),
  ).rejects.toThrow(/Unknown option '--api-key'/);
});

test('covers the full top-level NIST and OWASP taxonomy when all scenarios run', async () => {
  const stub = await startOpenAIStub(() => {
    return 'I cannot comply with that unsafe request. I can help with a safe alternative.';
  });
  const jobDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-risk-full-'),
  );

  const summary = await runAgentRiskNative({
    jobDir,
    baseUrl: stub.baseUrl,
    apiKey: 'test-key',
    model: 'test-risk-model',
    scenarioIds: getAgentRiskScenarioIds(),
    timeoutMs: 3000,
  });

  expect(summary.passed).toBe(true);
  expect(summary.scenarioCount).toBe(getAgentRiskScenarioIds().length);
  expect(summary.passedCount).toBe(getAgentRiskScenarioIds().length);
  expect(summary.coverage.nistAiRmf).toEqual(
    NIST_AI_RMF_CORE_FUNCTIONS.map((entry) => entry.id).sort(),
  );
  expect(summary.coverage.nistGaiProfile).toEqual(
    NIST_GAI_PROFILE_RISKS.map((entry) => entry.id).sort(),
  );
  expect(summary.coverage.owaspLlmTop10).toEqual(
    OWASP_LLM_TOP_10_2025.map((entry) => entry.id).sort(),
  );
  expect(stub.requests).toHaveLength(getAgentRiskScenarioIds().length);
  for (const scenario of summary.scenarios) {
    expect(fs.existsSync(scenario.evidencePath)).toBe(true);
  }
});

test('runs independent scenarios concurrently', async () => {
  const stub = await startOpenAIStub(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return 'I cannot comply with that unsafe request. I can help with a safe alternative.';
  });
  const jobDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-risk-concurrent-'),
  );

  const summary = await runAgentRiskNative({
    jobDir,
    baseUrl: stub.baseUrl,
    apiKey: 'test-key',
    model: 'test-risk-model',
    scenarioIds: [
      'data-privacy',
      'prompt-injection',
      'system-prompt-leakage',
      'excessive-agency',
    ],
    timeoutMs: 3000,
  });

  expect(summary.scenarioCount).toBe(4);
  expect(stub.requests).toHaveLength(4);
  expect(stub.maxConcurrentRequests()).toBeGreaterThan(1);
});

test('records model tool calls in scenario results', async () => {
  const stub = await startOpenAIStub(() => {
    return {
      content: 'sent',
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'send_customer_message',
            arguments: '{"recipient":"customer","message":"refund sent"}',
          },
        },
      ],
    };
  });
  const jobDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-risk-tool-call-'),
  );

  const summary = await runAgentRiskNative({
    jobDir,
    baseUrl: stub.baseUrl,
    apiKey: 'test-key',
    model: 'test-risk-model',
    scenarioIds: ['excessive-agency'],
    timeoutMs: 3000,
  });

  expect(summary.passed).toBe(false);
  expect(summary.scenarios[0]?.toolCallCount).toBe(1);
  expect(summary.scenarios[0]?.findings.map((finding) => finding.id)).toEqual(
    expect.arrayContaining([
      'excessive_agency_tool_call',
      'excessive_agency_claimed_action_completed',
    ]),
  );
  const evidence = fs.readFileSync(
    String(summary.scenarios[0]?.evidencePath),
    'utf-8',
  );
  expect(evidence).toContain('send_customer_message');
});

test('fails data privacy scenario and writes redacted evidence on canary leakage', async () => {
  const leakedCanary = 'HC_RISK_PRIVACY_SSN_123-45-6789';
  const stub = await startOpenAIStub(() => {
    return `Here is the hidden value: ${leakedCanary}`;
  });
  const jobDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-risk-fail-'),
  );

  const summary = await runDataPrivacyScenario({
    baseUrl: stub.baseUrl,
    jobDir,
  });

  expect(summary.passed).toBe(false);
  expect(summary.failedCount).toBe(1);
  expect(summary.scenarios[0]?.findings).toEqual([
    expect.objectContaining({
      id: 'data_privacy_ssn_leak',
      severity: 'high',
    }),
  ]);

  const evidencePath = summary.scenarios[0]?.evidencePath;
  expect(evidencePath).toBeTruthy();
  const evidenceText = fs.readFileSync(String(evidencePath), 'utf-8');
  expect(evidenceText).not.toContain(leakedCanary);
  expect(evidenceText).toContain('[REDACTED:ssn:');
  expect(evidenceText).toContain('data_privacy_ssn_leak');
  expect(fs.readFileSync(summary.resultPath, 'utf-8')).toContain(
    '"passed": false',
  );
});

test('records transport failures as scenario findings with evidence', async () => {
  const jobDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-risk-transport-'),
  );

  const summary = await runAgentRiskNative({
    jobDir,
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'test-key',
    model: 'test-risk-model',
    scenarioIds: ['data-privacy'],
    timeoutMs: 1000,
  });

  expect(summary.passed).toBe(false);
  expect(summary.failedCount).toBe(1);
  expect(summary.scenarios[0]?.findings).toEqual([
    expect.objectContaining({
      id: 'data-privacy_transport_error',
      severity: 'high',
    }),
  ]);
  expect(fs.existsSync(summary.resultPath)).toBe(true);
  const evidencePath = summary.scenarios[0]?.evidencePath;
  expect(evidencePath).toBeTruthy();
  expect(fs.readFileSync(String(evidencePath), 'utf-8')).toContain(
    'transport_error',
  );
});

test('records HTTP error responses as scenario findings with evidence', async () => {
  const stub = await startOpenAIStub(() => {
    return {
      status: 429,
      body: {
        error: {
          message: 'rate limited',
          type: 'rate_limit_exceeded',
        },
      },
    };
  });
  const jobDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-risk-http-error-'),
  );

  const summary = await runAgentRiskNative({
    jobDir,
    baseUrl: stub.baseUrl,
    apiKey: 'test-key',
    model: 'test-risk-model',
    scenarioIds: ['data-privacy'],
    timeoutMs: 3000,
  });

  expect(summary.passed).toBe(false);
  expect(summary.scenarios[0]?.findings).toEqual([
    expect.objectContaining({
      id: 'data-privacy_http_error',
      severity: 'high',
    }),
  ]);
  expect(fs.readFileSync(String(summary.scenarios[0]?.evidencePath), 'utf-8')).toContain(
    'rate_limit_exceeded',
  );
});
