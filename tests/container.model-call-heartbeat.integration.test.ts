import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import {
  STREAM_ACTIVITY_LINE,
  TOOL_ACTIVITY_HEARTBEAT_MS,
} from '../container/src/tool-activity-heartbeat.js';
import type {
  ContainerInput,
  ContainerOutput,
} from '../container/src/types.js';

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

test('a non-streaming model call keeps the gateway watchdog fed', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-model-heartbeat-'));
  const ipc = path.join(dir, 'ipc');
  fs.mkdirSync(ipc);

  server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the request before answering.
    }
    // Answer only after the heartbeat interval: a worker that stays silent
    // this long is what the gateway's inactivity watchdog stops.
    await delay(TOOL_ACTIVITY_HEARTBEAT_MS + 1_000);
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
  const stderrLines: string[] = [];
  let pending = '';
  worker.stderr?.on('data', (chunk) => {
    pending += String(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    stderrLines.push(...lines);
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
    channelId: 'scheduler',
    allowedTools: [],
    skipContainerSystemPrompt: true,
    ralphMaxIterations: 0,
    contextWindow: 128_000,
    messages: [{ role: 'user', content: 'Summarize the day.' }],
  };
  worker.stdin?.write(`${JSON.stringify(input)}\n`);

  const outputPath = path.join(ipc, 'output.json');
  const deadline = Date.now() + 40_000;
  let output: ContainerOutput | null = null;
  while (!output && Date.now() < deadline) {
    try {
      output = JSON.parse(
        fs.readFileSync(outputPath, 'utf8'),
      ) as ContainerOutput;
    } catch {
      if (worker.exitCode !== null) break;
      await delay(50);
    }
  }
  if (!output) {
    throw new Error(`Worker produced no output: ${stderrLines.join('\n')}`);
  }

  expect(output.status).toBe('success');
  expect(output.result).toBe('done');
  const callStart = stderrLines.findIndex((line) =>
    line.startsWith('[model] call start'),
  );
  const callEnd = stderrLines.findIndex((line) =>
    line.startsWith('[model] call success'),
  );
  expect(callStart).toBeGreaterThanOrEqual(0);
  expect(
    stderrLines
      .slice(callStart, callEnd)
      .filter((line) => line === STREAM_ACTIVITY_LINE).length,
  ).toBeGreaterThanOrEqual(1);
}, 60_000);
