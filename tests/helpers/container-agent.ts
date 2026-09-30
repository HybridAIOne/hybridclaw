/**
 * Runs the real container agent runtime (container/src/index.ts) against a
 * scripted model server: each model request gets the next reply, then a
 * plain "done". Workspace, HOME, data and IPC dirs live in a fresh temp dir
 * that is removed after each test, together with the runtime and the server.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import {
  encodeAuthenticatedInput,
  generateIpcAuthSecret,
} from '../../container/shared/ipc-input-auth.js';
import type {
  ContainerInput,
  ContainerOutput,
} from '../../container/src/types.js';
import {
  type ModelRequestBody,
  startScriptedModelServer,
} from './scripted-model-server.js';

export function useContainerAgentHarness() {
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

  return async function runContainerAgent(
    replies:
      | Array<Record<string, unknown>>
      | ((body: ModelRequestBody) => Promise<Record<string, unknown>>),
    overrides: Partial<ContainerInput> = {},
    files: Record<string, string | Uint8Array> = {},
    options: {
      prepare?: (dir: string) => Promise<Partial<ContainerInput>>;
      timeoutMs?: number;
    } = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-container-agent-'));
    dirs.push(dir);
    const ipc = path.join(dir, 'ipc');
    fs.mkdirSync(ipc);
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    const { server, port, requests } = await startScriptedModelServer(
      typeof replies === 'function'
        ? replies
        : () => replies.shift() ?? { role: 'assistant', content: 'done' },
    );
    servers.push(server);
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
          HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT: dir,
          HYBRIDCLAW_AGENT_IPC_DIR: ipc,
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
    const input: ContainerInput = {
      sessionId: 'test-session',
      agentId: 'test-agent',
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      provider: 'mlx',
      isLocal: true,
      model: 'mlx/test',
      chatbotId: '',
      enableRag: false,
      channelId: 'web',
      ralphMaxIterations: 0,
      skipContainerSystemPrompt: true,
      persistBashState: false,
      messages: [{ role: 'user', content: 'Read the synthetic notes' }],
      ...overrides,
      ...(await options.prepare?.(dir)),
    };
    const waitOutput = async (): Promise<ContainerOutput> => {
      const outputPath = path.join(ipc, 'output.json');
      const until = Date.now() + (options.timeoutMs ?? 10000);
      while (Date.now() < until) {
        // Missing and unparseable both mean not ready yet, as in readOutput
        // (src/infra/ipc.ts).
        try {
          const result = JSON.parse(
            fs.readFileSync(outputPath, 'utf8'),
          ) as ContainerOutput;
          fs.unlinkSync(outputPath);
          return result;
        } catch {}
        if (child.exitCode !== null) throw new Error(stderr);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Runtime did not return output: ${stderr}`);
    };
    // The first request carries the per-worker IPC auth secret via stdin, as
    // the runners do; follow-ups are written as authenticated envelopes.
    const ipcAuthSecret = generateIpcAuthSecret();
    child.stdin?.write(`${JSON.stringify({ ...input, ipcAuthSecret })}\n`);
    return {
      requests,
      output: await waitOutput(),
      dir,
      stderr: () => stderr,
      followup: async (patch: Partial<ContainerInput>) => {
        fs.writeFileSync(
          path.join(ipc, 'input.json'),
          encodeAuthenticatedInput(
            ipcAuthSecret,
            JSON.stringify({ ...input, ...patch }),
          ),
        );
        return waitOutput();
      },
    };
  };
}
