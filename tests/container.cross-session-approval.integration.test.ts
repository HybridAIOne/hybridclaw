import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type {
  ContainerInput,
  ContainerOutput,
} from '../container/src/types.js';

const children: ChildProcess[] = [];
const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return resolve();
          }
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
        }),
    ),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function modelServer(reply: Record<string, unknown>): Promise<string> {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the request; every call gets the same reply.
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'test',
        choices: [
          {
            message: reply,
            finish_reason: reply.tool_calls ? 'tool_calls' : 'stop',
          },
        ],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return `http://127.0.0.1:${address.port}/v1`;
}

// One agent worker process for one session, on the shared workspace.
async function startWorker(params: {
  workspace: string;
  sessionId: string;
  userText: string;
  modelReply: Record<string, unknown>;
}) {
  const ipc = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cross-session-ipc-'));
  dirs.push(ipc);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'container/src/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: params.workspace,
        HYBRIDCLAW_DATA_DIR: params.workspace,
        HYBRIDCLAW_AGENT_WORKSPACE_ROOT: params.workspace,
        HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT: params.workspace,
        HYBRIDCLAW_AGENT_IPC_DIR: ipc,
        CONTAINER_IDLE_TIMEOUT: '30000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let errors = '';
  child.stderr?.on('data', (chunk) => {
    errors += chunk;
  });
  child.stdout?.resume();
  const input: ContainerInput = {
    sessionId: params.sessionId,
    agentId: 'test-agent',
    apiKey: 'test-key',
    baseUrl: await modelServer(params.modelReply),
    provider: 'mlx',
    isLocal: true,
    localToolMode: 'full',
    model: 'mlx/test',
    chatbotId: '',
    enableRag: false,
    channelId: 'web',
    ralphMaxIterations: 0,
    skipContainerSystemPrompt: true,
    persistBashState: false,
    messages: [{ role: 'user', content: params.userText }],
  };
  const output = async (): Promise<ContainerOutput> => {
    const outputPath = path.join(ipc, 'output.json');
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      try {
        const result = JSON.parse(
          fs.readFileSync(outputPath, 'utf8'),
        ) as ContainerOutput;
        fs.unlinkSync(outputPath);
        return result;
      } catch {}
      if (child.exitCode !== null) throw new Error(errors);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Worker did not answer: ${errors}`);
  };
  child.stdin?.write(`${JSON.stringify(input)}\n`);
  return {
    output: await output(),
    reply: async (text: string) => {
      fs.writeFileSync(
        path.join(ipc, 'input.json'),
        JSON.stringify({
          ...input,
          messages: [...input.messages, { role: 'user', content: text }],
        }),
      );
      return output();
    },
  };
}

test('a yes in one session never runs a command another session is waiting on', {
  timeout: 60_000,
}, async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hc-cross-session-workspace-'),
  );
  dirs.push(workspace);
  fs.writeFileSync(path.join(workspace, 'deploy.sh'), 'echo ran > ran.txt\n');
  const ran = path.join(workspace, 'ran.txt');

  const sessionA = await startWorker({
    workspace,
    sessionId: 'session-a',
    userText: 'Deploy the site',
    modelReply: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_deploy',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'bash ./deploy.sh' }),
          },
        },
      ],
    },
  });
  expect(sessionA.output.pendingApproval?.approvalId).toBeTruthy();

  const sessionB = await startWorker({
    workspace,
    sessionId: 'session-b',
    userText: 'yes',
    modelReply: { role: 'assistant', content: 'Hello.' },
  });
  expect(sessionB.output.toolExecutions ?? []).toEqual([]);
  expect(fs.existsSync(ran)).toBe(false);

  await sessionA.reply('yes');
  expect(fs.existsSync(ran)).toBe(true);
});
