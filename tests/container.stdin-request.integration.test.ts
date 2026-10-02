import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import { encodeWarmWorkerFrame } from '../container/shared/warm-worker-frame.js';
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
} from '../container/src/types.js';
import { AGENT_READY_FOR_INPUT_LINE } from '../src/infra/warm-runner-utils.js';

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

interface ModelRequest {
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string } }>;
}

/** Model endpoint that answers every call with "done" and records requests. */
async function startModelServer(): Promise<{
  baseUrl: string;
  received: ModelRequest[];
}> {
  const received: ModelRequest[] = [];
  server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    received.push(JSON.parse(text) as ModelRequest);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'test',
        choices: [
          {
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address');
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, received };
}

/** Spawns an agent worker and resolves once it waits for stdin. */
async function startWorker(): Promise<{
  worker: ChildProcess;
  readOutput: () => Promise<ContainerOutput>;
}> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-stdin-request-'));
  const ipc = path.join(dir, 'ipc');
  fs.mkdirSync(ipc);
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
  // The agent starts reading stdin right after announcing readiness.
  const readyDeadline = Date.now() + 20_000;
  while (!stderr.includes(AGENT_READY_FOR_INPUT_LINE)) {
    if (Date.now() > readyDeadline || worker.exitCode !== null) {
      throw new Error(`Worker never became ready: ${stderr}`);
    }
    await delay(25);
  }

  const readOutput = async () => {
    const outputPath = path.join(ipc, 'output.json');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(
          fs.readFileSync(outputPath, 'utf8'),
        ) as ContainerOutput;
      } catch {
        if (worker.exitCode !== null) break;
        await delay(25);
      }
    }
    throw new Error(`Worker produced no output: ${stderr}`);
  };
  return { worker, readOutput };
}

function buildInput(
  baseUrl: string,
  overrides: Partial<ContainerInput>,
): ContainerInput {
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    apiKey: 'test-key',
    baseUrl,
    provider: 'hybridai',
    model: 'test-model',
    chatbotId: 'test-bot',
    enableRag: false,
    channelId: 'web',
    allowedTools: [],
    skipContainerSystemPrompt: true,
    ralphMaxIterations: 0,
    contextWindow: 128_000,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

test('the first request survives a pipe chunk that splits a character', async () => {
  const prompt = 'Fasse die Größenübersicht für das Café zusammen: 東京 ✓';
  const model = await startModelServer();
  const { worker, readOutput } = await startWorker();

  const payload = Buffer.from(
    `${JSON.stringify(
      buildInput(model.baseUrl, {
        messages: [{ role: 'user', content: prompt }],
      }),
    )}\n`,
  );
  // Cut inside the two-byte "ö" and let the agent read the halves separately.
  const cut = payload.indexOf(Buffer.from('ö')) + 1;
  worker.stdin?.write(payload.subarray(0, cut));
  await delay(200);
  worker.stdin?.write(payload.subarray(cut));

  const output = await readOutput();
  expect(output.status).toBe('success');
  const userMessages = model.received[0]?.messages.filter(
    (message) => message.role === 'user',
  );
  expect(userMessages?.at(-1)?.content).toBe(prompt);
}, 40_000);

test('a warm worker connects MCP before its first request and keeps it', async () => {
  const model = await startModelServer();
  const { worker, readOutput } = await startWorker();
  const mcpLog = path.join(dir || '', 'mcp.log');
  const mcpServers: ContainerInput['mcpServers'] = {
    probe: {
      transport: 'stdio',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/logging-mcp-server.mjs'), mcpLog],
    },
  };
  const readMcpLog = () =>
    fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8').split('\n') : [];

  worker.stdin?.write(encodeWarmWorkerFrame(mcpServers));
  const connectDeadline = Date.now() + 20_000;
  while (!readMcpLog().includes('tools/list')) {
    if (Date.now() > connectDeadline) {
      throw new Error('Warm worker never connected its MCP server');
    }
    await delay(25);
  }
  worker.stdin?.write(
    `${JSON.stringify(
      buildInput(model.baseUrl, {
        mcpServers,
        allowedTools: ['probe__ping'],
      }),
    )}\n`,
  );

  const output = await readOutput();
  expect(output.status).toBe('success');
  expect(model.received[0]?.tools?.map((tool) => tool.function.name)).toEqual([
    'probe__ping',
  ]);
  expect(readMcpLog().filter((method) => method === 'initialize')).toHaveLength(
    1,
  );
}, 40_000);
