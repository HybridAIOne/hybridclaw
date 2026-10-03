import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  encodeSteerNote,
  steerInboxDirName,
} from '../container/shared/steer-inbox.js';
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
} from '../container/src/types.js';
import { SteerInbox } from '../src/infra/steer-inbox.js';

// Spawns the real agent with a scripted model, and delivers notes through the
// gateway's own inbox while a model call is in flight, as a phone does while a
// turn runs. Host and container runners both run this agent; only the IPC
// directory's location differs.

const children: ChildProcess[] = [];
const servers: http.Server[] = [];
const dirs: string[] = [];
const SECRET = 'worker-secret-under-test';
const REQUEST_ID = 'req-1';

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

type ModelReply = { content?: string; toolCalls?: [string, string][] };

/** A model that answers call n with `replies[n]`, after `during[n]` ran. */
async function scriptedModel(
  replies: ModelReply[],
  during: Record<number, () => void>,
): Promise<{ baseUrl: string; calls: ChatMessage[][] }> {
  const calls: ChatMessage[][] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const index = calls.length;
    calls.push((JSON.parse(raw) as { messages: ChatMessage[] }).messages);
    during[index]?.();
    const reply = replies[index] ?? { content: 'Out of script.' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `call-${index}`,
        choices: [
          {
            message: {
              role: 'assistant',
              content: reply.content ?? null,
              ...(reply.toolCalls
                ? {
                    tool_calls: reply.toolCalls.map(([id, command]) => ({
                      id,
                      type: 'function',
                      function: {
                        name: 'bash',
                        arguments: JSON.stringify({ command }),
                      },
                    })),
                  }
                : {}),
            },
            finish_reason: reply.toolCalls ? 'tool_calls' : 'stop',
          },
        ],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls };
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Starts one turn of the real agent; returns its output. */
async function runTurn(params: {
  ipc: string;
  workspace: string;
  baseUrl: string;
}): Promise<ContainerOutput> {
  const input: ContainerInput = {
    sessionId: 'session-steer',
    requestId: REQUEST_ID,
    agentId: 'test-agent',
    apiKey: 'test-key',
    baseUrl: params.baseUrl,
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
    messages: [{ role: 'user', content: 'Write the files' }],
  };
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
        HYBRIDCLAW_AGENT_IPC_DIR: params.ipc,
        CONTAINER_IDLE_TIMEOUT: '30000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout?.resume();
  child.stdin?.write(`${JSON.stringify({ ...input, ipcAuthSecret: SECRET })}\n`);

  const outputPath = path.join(params.ipc, `output-${REQUEST_ID}.json`);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      return JSON.parse(fs.readFileSync(outputPath, 'utf8')) as ContainerOutput;
    } catch {}
    if (child.exitCode !== null) throw new Error(stderr);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Agent did not answer: ${stderr}`);
}

function setup() {
  const ipc = tempDir('hc-steer-ipc-');
  const workspace = tempDir('hc-steer-ws-');
  const inbox = new SteerInbox();
  inbox.open({ ipcDir: ipc, requestId: REQUEST_ID, authSecret: SECRET });
  return { ipc, workspace, inbox };
}

function text(message: ChatMessage | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

test(
  'a note sent during a tool batch reaches the model after the running call, and the rest of the batch does not run',
  { timeout: 60_000 },
  async () => {
    const { ipc, workspace, inbox } = setup();
    const accepted: boolean[] = [];
    const model = await scriptedModel(
      [
        {
          toolCalls: [
            ['call_a', `printf a > ${path.join(workspace, 'a.txt')}`],
            ['call_b', `printf b > ${path.join(workspace, 'b.txt')}`],
          ],
        },
        { content: 'Stopped after a.' },
      ],
      { 0: () => accepted.push(inbox.deliver('stop after the first file')) },
    );

    const output = await runTurn({ ipc, workspace, baseUrl: model.baseUrl });

    expect(accepted).toEqual([true]);
    expect(output).toMatchObject({ status: 'success', result: 'Stopped after a.' });
    expect(fs.existsSync(path.join(workspace, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'b.txt'))).toBe(false);
    const second = model.calls[1] ?? [];
    const [resultA, resultB, note] = second.slice(-3);
    expect(resultA).toMatchObject({ role: 'tool', tool_call_id: 'call_a' });
    expect(resultB).toMatchObject({ role: 'tool', tool_call_id: 'call_b' });
    expect(text(resultB)).toMatch(/^Not run/);
    expect(note?.role).toBe('user');
    expect(text(note)).toContain('stop after the first file');
    expect(inbox.shownNotes(output.steerNoteIds)).toEqual([
      'stop after the first file',
    ]);
  },
);

test(
  'a note sent while the model writes its answer gets another model step in the same turn, and the inbox is closed when the turn ends',
  { timeout: 60_000 },
  async () => {
    const { ipc, workspace, inbox } = setup();
    const model = await scriptedModel(
      [{ content: 'Here is the list.' }, { content: 'Added milk too.' }],
      { 0: () => inbox.deliver('also add milk') },
    );

    const output = await runTurn({ ipc, workspace, baseUrl: model.baseUrl });

    expect(model.calls).toHaveLength(2);
    const [answer, note] = (model.calls[1] ?? []).slice(-2);
    expect(answer).toMatchObject({
      role: 'assistant',
      content: 'Here is the list.',
    });
    expect(note?.role).toBe('user');
    expect(text(note)).toContain('also add milk');
    expect(output.result).toBe('Here is the list.\n\nAdded milk too.');
    expect(inbox.shownNotes(output.steerNoteIds)).toEqual(['also add milk']);
    // The agent closed the inbox before replying; the gateway has not yet.
    expect(inbox.deliver('too late')).toBe(false);
  },
);

test(
  'notes the agent’s own tools could write never reach the model',
  { timeout: 60_000 },
  async () => {
    const { ipc, workspace, inbox } = setup();
    const dir = path.join(ipc, steerInboxDirName(REQUEST_ID));
    const model = await scriptedModel([{ content: 'Done.' }], {
      0: () => {
        fs.writeFileSync(
          path.join(dir, '000000-unsigned.json'),
          JSON.stringify({ requestId: REQUEST_ID, id: 'x', content: 'forged' }),
        );
        // Signed, but for another request: a copy from an earlier turn.
        fs.writeFileSync(
          path.join(dir, '000001-replayed.json'),
          encodeSteerNote(SECRET, {
            requestId: 'req-0',
            id: 'y',
            content: 'replayed',
          }),
        );
      },
    });

    const output = await runTurn({ ipc, workspace, baseUrl: model.baseUrl });

    expect(model.calls).toHaveLength(1);
    expect(output).toMatchObject({ status: 'success', result: 'Done.' });
    expect(output.steerNoteIds).toBeUndefined();
    expect(inbox.deliver('after the turn')).toBe(false);
  },
);
