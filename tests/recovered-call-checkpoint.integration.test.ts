import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { toolResultFilePath } from '../container/shared/tool-history.js';
import { readTurnCheckpoint } from '../container/shared/turn-checkpoint.js';
import type { ContainerInput } from '../container/src/types.js';
import { restoreSpilledToolResults } from '../src/agent/spilled-tool-results.js';
import { recoverWorkerOutput } from '../src/infra/worker-recovery.js';
import { runContainerWorker } from './helpers/container-worker.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('recovered-call-checkpoint-');
const children: ChildProcess[] = [];
const servers: http.Server[] = [];
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

test('generated IDs and full outcomes survive SIGKILL without regenerating or executing again', async () => {
  const root = temp();
  const state = temp();
  const ipc = path.join(root, 'ipc');
  fs.mkdirSync(ipc);
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    calls++;
    const messages = JSON.parse(text).messages as Array<{
      role: string;
      tool_name?: string;
    }>;
    if (messages.some((message) => message.role === 'tool')) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'sample-model',
        done: true,
        done_reason: 'stop',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'bash',
                arguments: {
                  command: `printf 'once\\n' >> effects.txt; node -e "process.stdout.write('neutral-detail\\\\n'.repeat(3000))"`,
                },
              },
            },
          ],
        },
        prompt_eval_count: 100,
        eval_count: 25,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture port.');
  const input: ContainerInput = {
    sessionId: 'recovered-call',
    runId: 'run-a',
    provider: 'ollama',
    isLocal: true,
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'test-key',
    model: 'sample-model',
    chatbotId: '',
    enableRag: false,
    channelId: 'web',
    skipContainerSystemPrompt: true,
    approvalMode: 'full',
    allowedTools: ['bash'],
    messages: [
      { role: 'user', content: 'Run the neutral sample action once.' },
    ],
  };
  const env = {
    HOME: root,
    HYBRIDCLAW_DATA_DIR: root,
    HYBRIDCLAW_AGENT_WORKSPACE_ROOT: root,
    HYBRIDCLAW_AGENT_STATE_ROOT: state,
    HYBRIDCLAW_RETRY_ENABLED: 'false',
    CONTAINER_IDLE_TIMEOUT: '30000',
  };
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'container/src/index.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env, HYBRIDCLAW_AGENT_IPC_DIR: ipc },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdin?.write(`${JSON.stringify(input)}\n`);
  await vi.waitFor(
    () => {
      expect(calls, stderr).toBe(2);
      expect(
        readTurnCheckpoint(state, input.sessionId)?.messages[1].resultDigest,
      ).toBeDefined();
    },
    { timeout: 10_000 },
  );
  const checkpoint = readTurnCheckpoint(state, input.sessionId);
  const id = checkpoint?.messages[0].tool_calls?.[0].id;
  const digest = checkpoint?.messages[1].resultDigest;
  if (!id || !digest) throw new Error('Expected a committed call and result.');
  expect(id.trim()).not.toBe('');
  const full = fs.readFileSync(
    path.join(state, toolResultFilePath(input.sessionId, id, digest)),
    'utf8',
  );
  expect(full.length).toBeGreaterThan(40_000);
  const exited = new Promise<void>((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  const recovered = recoverWorkerOutput(
    { status: 'error', result: null, toolsUsed: [], error: 'Worker stopped.' },
    state,
    input.sessionId,
    input.runId,
    true,
  );
  const restored = restoreSpilledToolResults(recovered, {
    sessionId: input.sessionId,
    workspaceRoot: state,
  });
  expect(restored.toolExecutions?.[0]).toMatchObject({
    toolCallId: id,
    result: full,
  });
  expect(restored.toolHistory?.[0].tool_calls?.[0].id).toBe(id);
  expect(
    String(restored.toolHistoryForReplay?.[1].content).length,
  ).toBeLessThan(9_000);
  const replacement = await runContainerWorker(input, env);
  expect(replacement.status).toBe('error');
  expect(replacement.toolHistory?.[0].tool_calls?.[0].id).toBe(id);
  expect(replacement.toolExecutions?.[0].toolCallId).toBe(id);
  expect(calls).toBe(2);
  expect(fs.readFileSync(path.join(root, 'effects.txt'), 'utf8')).toBe(
    'once\n',
  );
});
