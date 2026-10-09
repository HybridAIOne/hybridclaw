import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
} from '../container/src/types.js';
import { useTempDir } from './test-utils.ts';

/**
 * A warm worker spawned while `browser.provider` was `local` serves a request
 * after the operator switched to the stealth `camofox` provider. The request,
 * not the worker's spawn environment, decides that `browser_navigate` is a
 * stealth activation, so it needs the operator opt-in and never reaches the
 * gateway's browser.
 */

const makeTempDir = useTempDir('hc-browser-stealth-');
let child: ChildProcess | null = null;
const servers: http.Server[] = [];

afterEach(async () => {
  const running = child;
  child = null;
  if (running && running.exitCode === null && running.signalCode === null) {
    await new Promise<void>((resolve) => {
      running.once('exit', () => resolve());
      running.kill('SIGTERM');
    });
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

function completion(message: Record<string, unknown>, finishReason: string) {
  return { id: 'test', choices: [{ message, finish_reason: finishReason }] };
}

test('a warm local-spawned worker gates navigation when the request selects camofox', async () => {
  const dir = makeTempDir();
  const ipc = path.join(dir, 'ipc');
  fs.mkdirSync(ipc);
  const gatewayBrowserCalls: string[] = [];
  const gatewayUrl = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/api/browser/tool') {
      gatewayBrowserCalls.push(JSON.parse(body).toolName);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, url: 'https://login.example.com/', title: 'Login' }));
  });
  const modelUrl = await listen(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const { messages } = JSON.parse(text) as { messages: ChatMessage[] };
    const reply = messages.some((message) => message.role === 'tool')
      ? completion({ role: 'assistant', content: 'done' }, 'stop')
      : completion(
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_nav',
                type: 'function',
                function: {
                  name: 'browser_navigate',
                  arguments: JSON.stringify({ url: 'https://login.example.com/' }),
                },
              },
            ],
          },
          'tool_calls',
        );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  });

  const worker = spawn(process.execPath, ['--import', 'tsx', 'container/src/index.ts'], {
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
      // The provider when the worker was spawned, before the switch.
      HYBRIDCLAW_BROWSER_PROVIDER: 'local',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  child = worker;
  let stderr = '';
  worker.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const input: ContainerInput = {
    sessionId: 'test-session',
    agentId: 'test-agent',
    apiKey: 'test-key',
    baseUrl: modelUrl,
    provider: 'hybridai',
    model: 'test-model',
    chatbotId: 'test-bot',
    enableRag: false,
    channelId: 'web',
    allowedTools: ['browser_navigate'],
    gatewayBaseUrl: gatewayUrl,
    gatewayApiToken: 'test-token',
    browserProvider: 'camofox',
    approvalMode: 'full',
    skipContainerSystemPrompt: true,
    ralphMaxIterations: 0,
    contextWindow: 128_000,
    messages: [{ role: 'user', content: 'Open the login page.' }],
  };
  worker.stdin?.write(`${JSON.stringify(input)}\n`);

  const outputPath = path.join(ipc, 'output.json');
  let output: ContainerOutput | undefined;
  const deadline = Date.now() + 30_000;
  while (!output && Date.now() < deadline) {
    try {
      output = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as ContainerOutput;
    } catch {
      if (worker.exitCode !== null) break;
      await delay(25);
    }
  }
  if (!output) throw new Error(`Worker produced no output: ${stderr}`);

  expect(gatewayBrowserCalls).toEqual([]);
  expect(output.toolExecutions?.[0]).toMatchObject({
    name: 'browser_navigate',
    blocked: true,
    approvalActionKey: 'browser_stealth:example.com',
  });
}, 60_000);
