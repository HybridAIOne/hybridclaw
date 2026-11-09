import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { readTurnCheckpoint } from '../container/shared/turn-checkpoint.js';
import type { ChatMessage, ContainerInput } from '../container/src/types.js';
import { recoverWorkerOutput } from '../src/infra/worker-recovery.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { runContainerWorker } from './helpers/container-worker.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('worker-auxiliary-usage-');
const servers: http.Server[] = [];
const children: ChildProcess[] = [];
const runConversation = useContainerAgentHarness();
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type Task = 'vision' | 'session_search' | 'file_preservation_review';
async function fixture(
  task: Task,
  options: { limited?: boolean; retry?: boolean; holdFinal?: boolean } = {},
) {
  const root = temp();
  fs.writeFileSync(
    path.join(root, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  fs.mkdirSync(path.join(root, '.session-transcripts'));
  fs.writeFileSync(
    path.join(root, '.session-transcripts', 'sample.jsonl'),
    `${JSON.stringify({
      sessionId: 'sample',
      role: 'user',
      content: 'Neutral release planning sample.',
      createdAt: '2026-01-01T00:00:00Z',
    })}\n`,
  );
  const original = 'Unrelated garden observations.\n';
  fs.writeFileSync(path.join(root, 'report.md'), original);
  const counts = { primary: 0, helpers: 0 };
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const helper = !body.tools?.length;
    if (helper) counts.helpers++;
    else counts.primary++;
    if (helper && options.retry && counts.helpers === 1) {
      res.writeHead(500);
      res.end('Fixture transient failure.');
      return;
    }
    if (!helper && options.holdFinal && counts.primary === 2) return;
    let message: ChatMessage;
    if (helper)
      message = {
        role: 'assistant',
        content:
          task === 'file_preservation_review'
            ? '{"decision":"reject","reason":"Unrelated document."}'
            : 'Complete neutral analysis.',
      };
    else if (task === 'file_preservation_review' && counts.primary <= 2)
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `sample-${counts.primary}`,
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({
                path: 'report.md',
                contents: 'Requested release report.',
                ...(counts.primary === 2
                  ? { overwrite: true, expected_content: original }
                  : {}),
              }),
            },
          },
        ],
      };
    else if (task !== 'file_preservation_review' && counts.primary === 1)
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'sample-call',
            type: 'function',
            function: {
              name: task === 'vision' ? 'vision_analyze' : 'session_search',
              arguments: JSON.stringify(
                task === 'vision'
                  ? { image_url: 'image.png', question: 'Describe the sample.' }
                  : { query: 'release', useLlmSummary: true },
              ),
            },
          },
        ],
      };
    else message = { role: 'assistant', content: 'The fixture has ended.' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message,
            finish_reason:
              helper && options.limited
                ? 'length'
                : message.tool_calls
                  ? 'tool_calls'
                  : 'stop',
          },
        ],
        usage: helper
          ? {
              prompt_tokens: 300,
              completion_tokens: 33,
              total_tokens: 333,
              cost_usd: 0.002,
            }
          : {
              prompt_tokens: 100,
              completion_tokens: 25,
              total_tokens: 125,
              cost_usd: 0.005,
            },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture port.');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const input: ContainerInput = {
    sessionId: 'auxiliary-accounting',
    runId: 'run-a',
    provider: 'vllm',
    isLocal: true,
    baseUrl,
    apiKey: 'test-key',
    model: 'vllm/primary-model',
    chatbotId: '',
    enableRag: false,
    channelId: 'web',
    skipContainerSystemPrompt: true,
    approvalMode: 'full',
    visualMediaAllowed: true,
    primaryModelSupportsVisualMedia: false,
    allowedTools: [
      task === 'vision'
        ? 'vision_analyze'
        : task === 'session_search'
          ? 'session_search'
          : 'write',
    ],
    ...(task !== 'file_preservation_review'
      ? {
          taskModels: {
            [task]: {
              provider: 'vllm',
              isLocal: true,
              baseUrl,
              apiKey: 'test-key',
              model: 'vllm/helper-model',
              chatbotId: '',
            },
          },
        }
      : {}),
    messages: [
      {
        role: 'user',
        content:
          task === 'file_preservation_review'
            ? 'Create a release report at report.md.'
            : 'Inspect the neutral sample.',
      },
    ],
  };
  const env = {
    HOME: root,
    HYBRIDCLAW_DATA_DIR: root,
    HYBRIDCLAW_AGENT_WORKSPACE_ROOT: root,
    HYBRIDCLAW_AGENT_STATE_ROOT: root,
    ...(options.retry
      ? {
          HYBRIDCLAW_RETRY_ENABLED: 'true',
          HYBRIDCLAW_RETRY_MAX_ATTEMPTS: '2',
          HYBRIDCLAW_RETRY_BASE_DELAY_MS: '100',
          HYBRIDCLAW_RETRY_MAX_DELAY_MS: '100',
        }
      : {}),
  };
  return { root, input, env, counts, original };
}

test.each(['vision', 'session_search', 'file_preservation_review'] as const)(
  'a worker retains all usage from its %s helper',
  async (task) => {
    const worker = await fixture(task);
    const output = await runContainerWorker(worker.input, worker.env);
    expect(output.status, output.error).toBe('success');
    expect(worker.counts.helpers).toBe(1);
    const primary = task === 'file_preservation_review' ? 3 : 2;
    expect(worker.counts.primary).toBe(primary);
    expect(output.tokenUsage?.apiTotalTokens).toBe(primary * 125 + 333);
    expect(output.tokenUsage?.modelCalls).toBe(primary + 1);
    expect(output.tokenUsage?.costUsd).toBeCloseTo(primary * 0.005 + 0.002);
    const helper = output.tokenUsage?.modelUsage?.filter((call) => call.task);
    expect(helper).toHaveLength(1);
    expect(helper?.[0]).toMatchObject({
      task,
      status: 'success',
      costUsd: 0.002,
      usage: { apiTotalTokens: 333 },
    });
    if (task === 'file_preservation_review')
      expect(fs.readFileSync(path.join(worker.root, 'report.md'), 'utf8')).toBe(
        worker.original,
      );
    else expect(output.toolExecutions?.[0].isError).not.toBe(true);
  },
);

test('a host-interpreted approval denial reports no worker inference', async () => {
  const worker = await runConversation(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'prepared-script',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({ command: 'bash ./sample.sh' }),
            },
          },
        ],
      },
    ],
    { messages: [{ role: 'user', content: 'Run the prepared sample.' }] },
    { 'sample.sh': 'printf sample\n' },
  );
  const approvalId = worker.output.pendingApproval?.approvalId;
  if (!approvalId) throw new Error('Expected the script approval fixture.');
  const denied = await worker.followup({
    requestId: 'denial',
    runId: 'run-b',
    approvalUserText: 'Cancel the sample.',
    approvalReplyDecision: {
      decision: 'deny',
      approvalId,
      scope: null,
      reply: 'Cancelled.',
    },
    messages: [{ role: 'user', content: 'Cancel the sample.' }],
  });
  expect(worker.requests).toHaveLength(1);
  expect(denied.tokenUsage).toMatchObject({
    modelCalls: 0,
    apiTotalTokens: 0,
    costUsd: 0,
    modelUsage: [],
  });
});

test('a token-limited vision failure retains the helper charge and reported tokens', async () => {
  const worker = await fixture('vision', { limited: true });
  const output = await runContainerWorker(worker.input, worker.env);
  expect(output.toolExecutions?.[0].isError).toBe(true);
  expect(output.tokenUsage).toMatchObject({
    modelCalls: 3,
    apiTotalTokens: 583,
  });
  expect(
    output.tokenUsage?.modelUsage?.find((call) => call.task === 'vision'),
  ).toMatchObject({ status: 'error', costUsd: 0.002 });
});

test('auxiliary retries are separate requests and do not invent a charge for an unreported error', async () => {
  const worker = await fixture('vision', { retry: true });
  const output = await runContainerWorker(worker.input, worker.env);
  expect(output.status, output.error).toBe('success');
  expect(worker.counts.helpers).toBe(2);
  expect(output.tokenUsage).toMatchObject({
    modelCalls: 4,
    apiTotalTokens: 583,
  });
  expect(output.tokenUsage?.costUsd).toBeUndefined();
  const helper = output.tokenUsage?.modelUsage?.filter((call) => call.task);
  expect(helper).toHaveLength(2);
  expect(helper?.[0]).toMatchObject({
    status: 'error',
    usage: { apiUsageAvailable: false },
  });
  expect(helper?.[1]).toMatchObject({ status: 'success', costUsd: 0.002 });
});

test('SIGKILL preserves completed helper usage and the unknown in-flight primary request', async () => {
  const worker = await fixture('vision', { holdFinal: true });
  const ipc = path.join(worker.root, 'ipc');
  fs.mkdirSync(ipc);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'container/src/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...worker.env,
        HYBRIDCLAW_AGENT_IPC_DIR: ipc,
        CONTAINER_IDLE_TIMEOUT: '30000',
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdin?.write(`${JSON.stringify(worker.input)}\n`);
  await vi.waitFor(
    () => {
      expect(worker.counts.primary, stderr).toBe(2);
      expect(
        readTurnCheckpoint(worker.root, worker.input.sessionId)?.tokenUsage
          ?.apiTotalTokens,
      ).toBe(458);
    },
    { timeout: 10_000 },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  const output = recoverWorkerOutput(
    { status: 'error', result: null, toolsUsed: [], error: 'Worker stopped.' },
    worker.root,
    worker.input.sessionId,
    worker.input.runId,
    true,
  );
  expect(output.tokenUsage).toMatchObject({
    modelCalls: 3,
    apiTotalTokens: 458,
  });
  expect(output.tokenUsage?.costUsd).toBeUndefined();
  expect(output.tokenUsage?.modelUsage).toMatchObject([
    { status: 'success', usage: { apiTotalTokens: 125 } },
    { task: 'vision', status: 'success', usage: { apiTotalTokens: 333 } },
    { status: 'running', usage: { apiUsageAvailable: false } },
  ]);
});
