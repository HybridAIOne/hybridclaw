import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ipcOutputFileName } from '@hybridclaw/shared/ipc-output-files';
import { toolResultFilePath } from '@hybridclaw/shared/tool-history';
import { readTurnCheckpoint } from '@hybridclaw/shared/turn-checkpoint';
import type { ChatMessage, ContainerInput, ContainerOutput } from '../container/src/types.js';
import { restoreSpilledToolResults } from '../src/agent/spilled-tool-results.js';
import { recoverWorkerOutput } from '../src/infra/worker-recovery.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('spilled-worker-kill-');
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

test('SIGKILL recovery restores a complete large result without repeating its action', async () => {
  const root = temp();
  const state = temp();
  const ipc = path.join(root, 'ipc');
  fs.mkdirSync(ipc);
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages as ChatMessage[];
    calls++;
    if (messages.some((message) => message.role === 'tool')) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: 'large', type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: "printf 'once\\n' >> effects.txt; node -e \"process.stdout.write('neutral-detail\\\\n'.repeat(3000))\"" }),
      } }],
    } }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const sessionId = 'spilled-worker';
  const input: ContainerInput = {
    sessionId, runId: 'run-a', requestId: 'request-a',
    messages: [{ role: 'user', content: 'Run the neutral sample action once.' }],
    provider: 'hybridai', apiKey: 'test-key', baseUrl: `http://127.0.0.1:${address.port}`,
    model: 'test-model', chatbotId: 'test-bot', enableRag: false,
    channelId: 'web', allowedTools: ['bash'], approvalMode: 'full',
    skipContainerSystemPrompt: true, ralphMaxIterations: 0,
  };
  let stderr = '';
  const start = () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'container/src/index.ts'], {
      cwd: process.cwd(), stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, HOME: root, HYBRIDCLAW_DATA_DIR: root,
        HYBRIDCLAW_AGENT_WORKSPACE_ROOT: root, HYBRIDCLAW_AGENT_STATE_ROOT: state,
        HYBRIDCLAW_AGENT_IPC_DIR: ipc, HYBRIDCLAW_RETRY_ENABLED: 'false', CONTAINER_IDLE_TIMEOUT: '30000' },
    });
    children.push(child);
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.stdin?.write(`${JSON.stringify(input)}\n`);
    return child;
  };
  const first = start();
  await vi.waitFor(() => {
    expect(calls, stderr).toBe(2);
    expect(readTurnCheckpoint(state, sessionId)?.messages.some((entry) => entry.role === 'tool')).toBe(true);
  }, { timeout: 10_000 });
  const exited = new Promise<void>((resolve) => first.once('exit', resolve));
  first.kill('SIGKILL');
  await exited;
  const fullResult = fs.readFileSync(path.join(state, toolResultFilePath(sessionId, 'large')), 'utf8');
  expect(fullResult.length).toBeGreaterThan(40_000);
  const recovered = recoverWorkerOutput({ status: 'error', result: null, toolsUsed: [], error: 'Worker exited.' }, state, sessionId, input.runId, true);
  expect(recovered.spilledToolCallIds).toEqual(['large']);
  const restored = restoreSpilledToolResults(recovered, { sessionId, workspaceRoot: state });
  expect(restored.toolExecutions?.[0].result).toBe(fullResult);
  expect(restored.toolHistory?.[1].content).toBe(fullResult);
  expect(String(restored.toolHistoryForReplay?.[1].content).length).toBeLessThan(9_000);
  input.requestId = 'request-b';
  start();
  const outputFile = path.join(ipc, ipcOutputFileName(input.requestId));
  await vi.waitFor(() => expect(fs.existsSync(outputFile), stderr).toBe(true), { timeout: 10_000 });
  const output = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as ContainerOutput;
  expect(output.status).toBe('error');
  expect(calls).toBe(2);
  expect(fs.readFileSync(path.join(root, 'effects.txt'), 'utf8')).toBe('once\n');
});
