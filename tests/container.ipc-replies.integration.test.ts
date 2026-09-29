import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { ipcOutputFileName } from '../container/shared/ipc-output-files.js';
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
} from '../container/src/types.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hc-ipc-replies-');
const children: ChildProcess[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

type ModelReply = (messages: ChatMessage[]) => Record<string, unknown> | null;

async function startAgent(reply: ModelReply) {
  const dir = makeTempDir();
  const ipc = path.join(dir, 'ipc');
  fs.mkdirSync(ipc);
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = reply(JSON.parse(body).messages as ChatMessage[]);
    if (!message) return; // hold the model call open
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message,
            finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
          },
        ],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'container/src/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: dir,
        HYBRIDCLAW_DATA_DIR: dir,
        HYBRIDCLAW_AGENT_WORKSPACE_ROOT: dir,
        HYBRIDCLAW_AGENT_IPC_DIR: ipc,
        HYBRIDCLAW_RETRY_ENABLED: 'false',
        CONTAINER_IDLE_TIMEOUT: '30000',
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const input = (requestId: string, content: string): ContainerInput => ({
    sessionId: 'session-ipc-replies',
    requestId,
    messages: [{ role: 'user', content }],
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${address.port}`,
    provider: 'hybridai',
    model: 'test-model',
    chatbotId: 'test-bot',
    enableRag: false,
    channelId: 'web',
    allowedTools: ['delegate'],
    skipContainerSystemPrompt: true,
    contextWindow: 128_000,
  });
  const waitForReply = async (requestId: string): Promise<ContainerOutput> => {
    const replyPath = path.join(ipc, ipcOutputFileName(requestId));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(replyPath)) {
        return JSON.parse(fs.readFileSync(replyPath, 'utf8'));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No reply for ${requestId}: ${stderr}`);
  };
  return { child, ipc, input, waitForReply };
}

test('the agent answers each request in that request’s reply file', async () => {
  const agent = await startAgent((messages) => ({
    role: 'assistant',
    content: `answer to ${messages.at(-1)?.content}`,
  }));

  agent.child.stdin?.write(
    `${JSON.stringify(agent.input('request-1', 'first'))}\n`,
  );
  await expect(agent.waitForReply('request-1')).resolves.toMatchObject({
    status: 'success',
    result: 'answer to first',
  });
  fs.writeFileSync(
    path.join(agent.ipc, 'input.json'),
    JSON.stringify(agent.input('request-2', 'second')),
  );
  await expect(agent.waitForReply('request-2')).resolves.toMatchObject({
    status: 'success',
    result: 'answer to second',
  });
  expect(fs.existsSync(path.join(agent.ipc, 'output.json'))).toBe(false);
});

test('an interrupted request’s SIGTERM reply lands in that request’s reply file', async () => {
  let delegated!: () => void;
  const delegationQueued = new Promise<void>((resolve) => {
    delegated = resolve;
  });
  const agent = await startAgent((messages) => {
    if (!messages.some((message) => message.role === 'tool')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-delegate',
            type: 'function',
            function: {
              name: 'delegate',
              arguments: JSON.stringify({
                prompt: 'research the topic',
                background: true,
              }),
            },
          },
        ],
      };
    }
    delegated();
    return null;
  });

  agent.child.stdin?.write(
    `${JSON.stringify(agent.input('request-a', 'delegate the research'))}\n`,
  );
  await delegationQueued;
  const exited = new Promise((resolve) => agent.child.once('exit', resolve));
  agent.child.kill('SIGTERM');
  await exited;

  await expect(agent.waitForReply('request-a')).resolves.toMatchObject({
    status: 'error',
    error: expect.stringContaining('received SIGTERM'),
    sideEffects: {
      delegations: [
        expect.objectContaining({ action: 'delegate', prompt: 'research the topic' }),
      ],
    },
  });
  expect(fs.existsSync(path.join(agent.ipc, 'output.json'))).toBe(false);
});
