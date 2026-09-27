import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
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

test('the first request survives a pipe chunk that splits a character', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-stdin-request-'));
  const ipc = path.join(dir, 'ipc');
  fs.mkdirSync(ipc);
  const prompt = 'Fasse die Größenübersicht für das Café zusammen: 東京 ✓';

  const received: ChatMessage[][] = [];
  server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    received.push((JSON.parse(text) as { messages: ChatMessage[] }).messages);
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
    allowedTools: [],
    skipContainerSystemPrompt: true,
    ralphMaxIterations: 0,
    contextWindow: 128_000,
    messages: [{ role: 'user', content: prompt }],
  };
  const payload = Buffer.from(`${JSON.stringify(input)}\n`);
  // Cut inside the two-byte "ö" and let the agent read the halves separately:
  // it starts reading stdin right after announcing readiness.
  const cut = payload.indexOf(Buffer.from('ö')) + 1;
  const readyDeadline = Date.now() + 20_000;
  while (!stderr.includes(AGENT_READY_FOR_INPUT_LINE)) {
    if (Date.now() > readyDeadline || worker.exitCode !== null) {
      throw new Error(`Worker never became ready: ${stderr}`);
    }
    await delay(25);
  }
  worker.stdin?.write(payload.subarray(0, cut));
  await delay(200);
  worker.stdin?.write(payload.subarray(cut));

  const outputPath = path.join(ipc, 'output.json');
  const deadline = Date.now() + 20_000;
  let output: ContainerOutput | null = null;
  while (!output && Date.now() < deadline) {
    try {
      output = JSON.parse(
        fs.readFileSync(outputPath, 'utf8'),
      ) as ContainerOutput;
    } catch {
      if (worker.exitCode !== null) break;
      await delay(25);
    }
  }
  if (!output) throw new Error(`Worker produced no output: ${stderr}`);

  expect(output.status).toBe('success');
  const userMessages = received[0]?.filter(
    (message) => message.role === 'user',
  );
  expect(userMessages?.at(-1)?.content).toBe(prompt);
}, 40_000);
