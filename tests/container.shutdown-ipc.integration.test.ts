import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { ipcOutputFileName } from '../container/shared/ipc-output-files.js';
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
} from '../container/src/types.js';
import { useTempDir } from './test-utils.js';

const SLOW_EXIT_MCP_SERVER = path.resolve(
  'tests/fixtures/slow-exit-mcp-server.mjs',
);
const makeTempDir = useTempDir('hc-agent-shutdown-ipc-');
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

type ModelReply = (
  messages: ChatMessage[],
) => Promise<Record<string, unknown>> | Record<string, unknown>;

// Each entry adds a slow-exit MCP server with those flags; by default one
// server holds the agent's teardown open for 1.5s after SIGTERM.
async function startAgent(
  reply: ModelReply,
  mcpServerFlags: string[][] = [[]],
) {
  const dir = makeTempDir();
  const ipc = path.join(dir, 'ipc');
  fs.mkdirSync(ipc);
  const modelCalls: ChatMessage[][] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages as ChatMessage[];
    modelCalls.push(messages);
    const message = await reply(messages);
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
  const exited = new Promise<number>((resolve) =>
    child.once('exit', () => resolve(Date.now())),
  );
  const request = (requestId: string, content: string): ContainerInput => ({
    sessionId: 'session-shutdown-ipc',
    requestId,
    messages: [{ role: 'user', content }],
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${address.port}`,
    provider: 'hybridai',
    model: 'test-model',
    chatbotId: 'test-bot',
    enableRag: false,
    channelId: 'web',
    allowedTools: ['write', 'delete'],
    skipContainerSystemPrompt: true,
    contextWindow: 128_000,
    mcpServers: Object.fromEntries(
      mcpServerFlags.map((flags, index) => [
        `slow-${index}`,
        {
          transport: 'stdio' as const,
          command: process.execPath,
          args: [SLOW_EXIT_MCP_SERVER, ...flags],
        },
      ]),
    ),
  });
  const ipcFile = (name: string) => path.join(ipc, name);
  // Reads and removes a request's reply file, as the gateway does.
  const takeReply = async (requestId: string): Promise<ContainerOutput> => {
    const replyPath = ipcFile(ipcOutputFileName(requestId));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(replyPath)) {
        const output = JSON.parse(fs.readFileSync(replyPath, 'utf8'));
        fs.unlinkSync(replyPath);
        return output;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No reply: ${stderr}`);
  };
  const stopAgent = async () => {
    child.kill('SIGTERM');
    await vi.waitFor(
      () => expect(stderr).toContain('shutting down (SIGTERM)'),
      { timeout: 5_000 },
    );
  };
  return {
    child,
    dir,
    ipc,
    exited,
    modelCalls,
    request,
    ipcFile,
    takeReply,
    stopAgent,
    stderr: () => stderr,
  };
}

test('a stopping agent leaves new input in the IPC dir for its replacement', async () => {
  const agent = await startAgent((messages) => ({
    role: 'assistant',
    content: `answer to ${messages.at(-1)?.content}`,
  }));
  agent.child.stdin?.write(
    `${JSON.stringify(agent.request('request-1', 'first'))}\n`,
  );
  await expect(agent.takeReply('request-1')).resolves.toMatchObject({
    result: 'answer to first',
  });

  await agent.stopAgent();
  fs.writeFileSync(
    agent.ipcFile('input.json'),
    JSON.stringify(agent.request('request-2', 'meant for the replacement')),
  );
  fs.writeFileSync(
    agent.ipcFile('health-input.json'),
    JSON.stringify({
      ...agent.request('probe-1', 'probe'),
      healthCheck: { nonce: 'probe-1' },
    }),
  );
  const writtenAt = Date.now();

  // Still running for several poll intervals after the input arrived.
  expect((await agent.exited) - writtenAt).toBeGreaterThan(500);
  expect(fs.readdirSync(agent.ipc).sort()).toEqual([
    'health-input.json',
    'input.json',
  ]);
  expect(agent.modelCalls).toHaveLength(1);
}, 30_000);

const toolCall = (name: string, args: Record<string, unknown>) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'call-1',
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

// `message` is what the stopped turn's model call returns after the stop.
test.each([
  {
    work: 'tool run',
    message: toolCall('write', { path: 'after-stop.txt', contents: 'late' }),
  },
  { work: 'approval', message: toolCall('delete', { path: 'notes.txt' }) },
  // An empty completion makes the loop call the model again.
  { work: 'model call', message: { role: 'assistant', content: '' } },
  { work: 'reply', message: { role: 'assistant', content: 'late answer' } },
])('a stopped turn keeps its one interrupted reply and starts no $work', async ({
  message,
}) => {
  let releaseModelCall!: () => void;
  const modelCallReleased = new Promise<void>((resolve) => {
    releaseModelCall = resolve;
  });
  const agent = await startAgent(async (messages) => {
    if (messages.some((entry) => entry.role === 'tool')) {
      return { role: 'assistant', content: 'done' };
    }
    await modelCallReleased;
    return message;
  });
  agent.child.stdin?.write(
    `${JSON.stringify(agent.request('request-1', 'go'))}\n`,
  );
  await vi.waitFor(() => expect(agent.modelCalls).toHaveLength(1), {
    timeout: 10_000,
  });

  await agent.stopAgent();
  // The one reply, in the stopped request's own reply file.
  await expect(agent.takeReply('request-1')).resolves.toMatchObject({
    status: 'error',
    error: expect.stringContaining('received SIGTERM'),
  });
  // The stopped turn's model call returns while the gateway already writes
  // the next request for the replacement agent.
  releaseModelCall();
  fs.writeFileSync(
    agent.ipcFile('input.json'),
    JSON.stringify(agent.request('request-2', 'meant for the replacement')),
  );
  const writtenAt = Date.now();

  expect((await agent.exited) - writtenAt).toBeGreaterThan(500);
  expect(agent.modelCalls).toHaveLength(1);
  expect(fs.readdirSync(agent.ipc)).toEqual(['input.json']);
  for (const trace of ['after-stop.txt', '.hybridclaw/pending-approvals.json']) {
    expect(fs.existsSync(path.join(agent.dir, trace))).toBe(false);
  }
}, 30_000);

test('a stop during the implicit approval delay cancels the tool', async () => {
  // Two servers the MCP SDK kills 4s into their teardown each keep the agent
  // running past the 5s delay.
  const agent = await startAgent(
    (messages) =>
      messages.some((message) => message.role === 'tool')
        ? { role: 'assistant', content: 'done' }
        : toolCall('write', { path: 'after-stop.txt', contents: 'late' }),
    [['--hold'], ['--hold']],
  );
  fs.mkdirSync(path.join(agent.dir, '.hybridclaw'));
  fs.writeFileSync(
    path.join(agent.dir, '.hybridclaw', 'policy.yaml'),
    'approval:\n  implicit_delay_enabled: true\n',
  );
  agent.child.stdin?.write(
    `${JSON.stringify(agent.request('request-1', 'go'))}\n`,
  );
  // Logged as the delay starts; without the delay the tool would run now.
  await vi.waitFor(() => expect(agent.stderr()).toContain('[tool] write'), {
    timeout: 10_000,
  });

  await agent.stopAgent();
  await expect(agent.takeReply('request-1')).resolves.toMatchObject({
    status: 'error',
  });
  const stoppedAt = Date.now();

  expect((await agent.exited) - stoppedAt).toBeGreaterThan(5_000);
  expect(fs.existsSync(path.join(agent.dir, 'after-stop.txt'))).toBe(false);
  expect(agent.modelCalls).toHaveLength(1);
}, 30_000);
