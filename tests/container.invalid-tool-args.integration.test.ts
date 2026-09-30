import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import { MAX_INVALID_TOOL_CALL_RETRIES } from '../container/src/stalled-turns.js';
import { validateStructuredToolCalls } from '../container/src/tool-call-validation.js';
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
  ToolCall,
} from '../container/src/types.js';

const TRUNCATED_WRITE: ToolCall = {
  id: 'call_write',
  type: 'function',
  function: {
    name: 'write',
    arguments: '{"path":"report.md","contents":"# Report\\n\\nPartial',
  },
};
const VALIDATION_ERROR = validateStructuredToolCalls([TRUNCATED_WRITE]) || '';

let child: ChildProcess | null = null;
let server: http.Server | null = null;
let dir: string | null = null;

afterEach(async () => {
  const running = child;
  child = null;
  if (running && running.exitCode === null && running.signalCode === null) {
    await new Promise<void>((resolve) => {
      running.once('exit', () => resolve());
      running.kill('SIGTERM');
    });
  }
  const listening = server;
  server = null;
  if (listening) {
    await new Promise<void>((resolve) => {
      listening.close(() => resolve());
      listening.closeAllConnections();
    });
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function completion(message: Record<string, unknown>, finishReason: string) {
  return {
    id: 'test',
    choices: [{ message, finish_reason: finishReason }],
  };
}

const CUT_OFF_REPLY = completion(
  { role: 'assistant', content: null, tool_calls: [TRUNCATED_WRITE] },
  'length',
);

async function runTurn(
  reply: (messages: ChatMessage[]) => unknown,
): Promise<{ output: ContainerOutput; requests: ChatMessage[][] }> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-invalid-tool-args-'));
  const ipc = path.join(dir, 'ipc');
  fs.mkdirSync(ipc);
  const requests: ChatMessage[][] = [];
  server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const { messages } = JSON.parse(text) as { messages: ChatMessage[] };
    requests.push(messages);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply(messages)));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address');
  }

  const worker = spawn(
    process.execPath,
    ['--import', 'tsx', 'container/src/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: dir,
        HYBRIDCLAW_DATA_DIR: dir,
        HYBRIDCLAW_AGENT_WORKSPACE_ROOT: dir,
        HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT: dir,
        HYBRIDCLAW_AGENT_IPC_DIR: ipc,
        HYBRIDCLAW_RETRY_ENABLED: 'false',
        CONTAINER_IDLE_TIMEOUT: '30000',
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  child = worker;
  let stderr = '';
  worker.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const input: ContainerInput = {
    sessionId: 'test-session',
    agentId: 'test-agent',
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${address.port}`,
    provider: 'hybridai',
    model: 'test-model',
    chatbotId: 'test-bot',
    enableRag: false,
    channelId: 'web',
    allowedTools: ['write'],
    skipContainerSystemPrompt: true,
    ralphMaxIterations: 0,
    contextWindow: 128_000,
    messages: [{ role: 'user', content: 'Write the report.' }],
  };
  worker.stdin?.write(`${JSON.stringify(input)}\n`);

  const outputPath = path.join(ipc, 'output.json');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const output = JSON.parse(
        fs.readFileSync(outputPath, 'utf8'),
      ) as ContainerOutput;
      return { output, requests };
    } catch {
      if (worker.exitCode !== null) break;
      await delay(25);
    }
  }
  throw new Error(`Worker produced no output: ${stderr}`);
}

test('a cut-off tool call goes back to the model instead of failing the turn', async () => {
  const { output, requests } = await runTurn((messages) =>
    messages.some((message) => message.role === 'tool')
      ? completion({ role: 'assistant', content: 'done' }, 'stop')
      : CUT_OFF_REPLY,
  );

  expect(output.status).toBe('success');
  expect(output.result).toBe('done');
  expect(requests).toHaveLength(2);
  const replayedCall = requests[1].find(
    (message) => message.role === 'assistant',
  )?.tool_calls?.[0];
  expect(replayedCall?.id).toBe(TRUNCATED_WRITE.id);
  expect(replayedCall?.function.arguments).toBe('{}');
  const toolResult = requests[1].find((message) => message.role === 'tool');
  expect(toolResult?.tool_call_id).toBe(TRUNCATED_WRITE.id);
  expect(String(toolResult?.content)).toContain(VALIDATION_ERROR);
  expect(output.toolExecutions?.[0]).toMatchObject({
    name: 'write',
    blocked: true,
    isError: true,
  });
  expect(fs.existsSync(path.join(dir || '', 'report.md'))).toBe(false);
}, 40_000);

test('a model that keeps sending broken arguments still fails the turn', async () => {
  const { output, requests } = await runTurn(() => CUT_OFF_REPLY);

  expect(output.status).toBe('error');
  expect(output.error).toBe(VALIDATION_ERROR);
  expect(requests).toHaveLength(MAX_INVALID_TOOL_CALL_RETRIES + 1);
}, 40_000);

test('a call to a tool outside the request allowlist fails the turn without running', async () => {
  const { output, requests } = await runTurn(() =>
    completion(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bash',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({ command: 'touch outside.txt' }),
            },
          },
        ],
      },
      'tool_calls',
    ),
  );

  expect(output.status).toBe('error');
  expect(output.error).toContain('not available in this request: bash');
  expect(requests).toHaveLength(1);
  expect(output.toolExecutions ?? []).toEqual([]);
  expect(fs.existsSync(path.join(dir || '', 'outside.txt'))).toBe(false);
}, 40_000);
