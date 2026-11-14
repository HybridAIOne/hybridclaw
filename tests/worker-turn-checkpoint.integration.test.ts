import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ipcOutputFileName } from '@hybridclaw/shared/ipc-output-files';
import {
  checkpointOutput,
  readTurnCheckpoint,
  turnCheckpointPath,
} from '@hybridclaw/shared/turn-checkpoint';
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
} from '../container/src/types.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('worker-checkpoint-kill-');
const children: ChildProcess[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGKILL');
      await exited;
    }),
  );
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.each(['completed', 'uncertain', 'not_started', 'corrupt'] as const)(
  'SIGKILL preserves %s evidence and restarting the same run never repeats the action',
  async (boundary) => {
    const root = temp();
    const state = temp();
    const ipc = path.join(root, 'ipc');
    fs.mkdirSync(ipc);
    const effect = path.join(root, 'actions.txt');
    const sessionId = 'kill-recovery';
    let calls = 0;
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const messages = JSON.parse(body).messages as ChatMessage[];
      calls++;
      // Hold the model after the completed tool has been returned to it.
      if (messages.some((entry) => entry.role === 'tool')) return;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          usage: {
            prompt_tokens: 120,
            completion_tokens: 12,
            total_tokens: 132,
          },
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'action-a',
                    type: 'function',
                    function: {
                      name: 'bash',
                      arguments: JSON.stringify({
                        command:
                          boundary !== 'uncertain'
                            ? "printf 'action\\n' >> actions.txt"
                            : "printf 'action\\n' >> actions.txt; while [ ! -f release ]; do sleep 0.05; done; printf done > shell-finished",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No server address.');
    const input: ContainerInput = {
      sessionId,
      runId: 'run-a',
      requestId: 'request-a',
      messages: [{ role: 'user', content: 'Run the sample action once.' }],
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${address.port}`,
      provider: 'hybridai',
      model: 'test-model',
      chatbotId: 'test-bot',
      enableRag: false,
      channelId: 'web',
      allowedTools: ['bash'],
      approvalMode: 'full',
      skipContainerSystemPrompt: true,
      contextWindow: 128_000,
      ralphMaxIterations: 0,
    };
    let stderr = '';
    let starts = 0;
    const blockedStart = path.join(root, 'blocked-start');
    const start = () => {
      const child = spawn(
        process.execPath,
        [
          '--import', 'tsx',
          ...(boundary === 'not_started' && starts++ === 0 ? ['--import',
            `data:text/javascript,${encodeURIComponent(`
              import fs from 'node:fs';
              import path from 'node:path';
              const rename = fs.renameSync;
              fs.renameSync = function(from, to) {
                if (path.basename(String(to)) === 'turn-checkpoint.json' &&
                    JSON.parse(fs.readFileSync(from, 'utf8')).started.length) {
                  fs.writeFileSync(${JSON.stringify(blockedStart)}, '');
                  process.kill(process.pid, 'SIGSTOP');
                }
                return rename(from, to);
              };
            `)}`] : []),
          'container/src/index.ts',
        ],
        {
          cwd: process.cwd(),
          stdio: ['pipe', 'ignore', 'pipe'],
          env: {
            ...process.env,
            HOME: root,
            HYBRIDCLAW_DATA_DIR: root,
            HYBRIDCLAW_AGENT_WORKSPACE_ROOT: root,
            HYBRIDCLAW_AGENT_STATE_ROOT: state,
            HYBRIDCLAW_AGENT_IPC_DIR: ipc,
            HYBRIDCLAW_RETRY_ENABLED: 'false',
            CONTAINER_IDLE_TIMEOUT: '30000',
          },
        },
      );
      children.push(child);
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdin?.write(`${JSON.stringify(input)}\n`);
      return child;
    };
    const first = start();
    try {
      await vi.waitFor(
        () => {
          expect(fs.existsSync(boundary === 'not_started' ? blockedStart : effect), stderr).toBe(true);
          const saved = readTurnCheckpoint(state, sessionId)!;
          if (boundary === 'completed' || boundary === 'corrupt')
            expect(saved.messages.some((entry) => entry.role === 'tool')).toBe(
              true,
            );
          else expect(saved.started).toHaveLength(boundary === 'not_started' ? 0 : 1);
        },
        { timeout: 10_000 },
      );
      const exited = new Promise<void>((resolve) =>
        first.once('exit', () => resolve()),
      );
      first.kill('SIGKILL');
      await exited;
      const evidence = checkpointOutput(readTurnCheckpoint(state, sessionId)!);
      expect(evidence.tokenUsage).toMatchObject({
        apiUsageAvailable: true,
        apiPromptTokens: 120,
        apiCompletionTokens: 12,
        apiTotalTokens: 132,
      });
      expect(evidence.toolHistory).toHaveLength(2);
      expect(evidence.toolHistory[1].is_error === true).toBe(
        boundary === 'uncertain' || boundary === 'not_started',
      );
      if (boundary === 'uncertain')
        expect(evidence.toolHistory[1].content).toContain('unknown');
      const callsBeforeRestart = calls;
      if (boundary === 'corrupt') fs.writeFileSync(turnCheckpointPath(state, sessionId), '{');
      // Unblock the orphaned shell after the kill; it must not be started again.
      fs.writeFileSync(path.join(root, 'release'), '');
      input.requestId = 'request-b';
      start();
      const outputFile = path.join(ipc, ipcOutputFileName(input.requestId));
      await vi.waitFor(
        () => expect(fs.existsSync(outputFile), stderr).toBe(true),
        { timeout: 10_000 },
      );
      const output = JSON.parse(
        fs.readFileSync(outputFile, 'utf8'),
      ) as ContainerOutput;
      expect(output.status).toBe('error');
      if (boundary !== 'corrupt') {
        expect(output.toolHistory).toEqual(evidence.toolHistory);
        expect(output.tokenUsage).toEqual(evidence.tokenUsage);
      } else {
        expect(output.toolHistory).toBeUndefined();
        expect(output.tokenUsage?.apiUsageAvailable).not.toBe(true);
      }
      expect(calls).toBe(callsBeforeRestart);
      if (boundary === 'not_started') expect(fs.existsSync(effect)).toBe(false);
      else expect(fs.readFileSync(effect, 'utf8').trim().split('\n')).toEqual(['action']);
    } finally {
      fs.writeFileSync(path.join(root, 'release'), '');
      if (boundary === 'uncertain' && fs.existsSync(effect)) {
        await vi.waitFor(() =>
          expect(fs.existsSync(path.join(root, 'shell-finished'))).toBe(true),
        );
      }
    }
  },
  30_000,
);
