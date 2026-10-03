import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import {
  encodeAuthenticatedInput,
  generateIpcAuthSecret,
} from '../container/shared/ipc-input-auth.js';
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
} from '../container/src/types.js';

type ModelRequest = {
  headers: http.IncomingHttpHeaders;
  messages: ChatMessage[];
};
type ModelReply = { status: number; body: unknown };
type RequestSite = 'first' | 'follow-up';

const WARM_UP = 'warm-up';
const MEDIA_REJECTION: ModelReply = {
  status: 400,
  body: {
    error: { message: 'image_url content parts are not supported' },
  },
};

const children: ChildProcess[] = [];
const servers: http.Server[] = [];
const dirs: string[] = [];

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

function hasImagePart(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url'),
  );
}

function isWarmUp(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) => message.role === 'user' && message.content === WARM_UP,
  );
}

function completion(message: Record<string, unknown>): ModelReply {
  return {
    status: 200,
    body: {
      id: 'test',
      choices: [
        {
          message,
          finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
        },
      ],
    },
  };
}

const READ_NOTES = completion({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'call_read',
      type: 'function',
      function: { name: 'read', arguments: '{"path":"notes.txt"}' },
    },
  ],
});

function correlationHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.startsWith('x-hybridclaw-')),
  );
}

async function startWorker(reply: (messages: ChatMessage[]) => ModelReply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-native-media-retry-'));
  dirs.push(dir);
  const ipc = path.join(dir, 'ipc');
  fs.mkdirSync(ipc);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'synthetic notes');
  fs.writeFileSync(path.join(dir, 'photo.png'), 'synthetic image bytes');

  const requests: ModelRequest[] = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const { messages } = JSON.parse(text) as { messages: ChatMessage[] };
    requests.push({ headers: req.headers, messages });
    const { status, body } = isWarmUp(messages)
      ? completion({ role: 'assistant', content: 'ready' })
      : reply(messages);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address');
  }

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
        HYBRIDCLAW_RETRY_ENABLED: 'false',
        CONTAINER_IDLE_TIMEOUT: '30000',
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const ipcAuthSecret = generateIpcAuthSecret();
  const base: ContainerInput = {
    sessionId: 'test-session',
    agentId: 'test-agent',
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${address.port}`,
    provider: 'hybridai',
    model: 'test-vision-model',
    chatbotId: 'test-bot',
    enableRag: false,
    channelId: 'web',
    allowedTools: ['read'],
    skipContainerSystemPrompt: true,
    ralphMaxIterations: 0,
    contextWindow: 128_000,
    messages: [{ role: 'user', content: WARM_UP }],
  };
  const mediaTurn: Partial<ContainerInput> = {
    messages: [
      { role: 'user', content: 'Read notes.txt and describe the photo.' },
    ],
    media: [
      {
        path: path.join(dir, 'photo.png'),
        url: 'file://photo.png',
        originalUrl: 'file://photo.png',
        mimeType: 'image/png',
        sizeBytes: 21,
        filename: 'photo.png',
      },
    ],
  };
  const waitOutput = async (): Promise<ContainerOutput> => {
    const outputPath = path.join(ipc, 'output.json');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      // Missing and unparseable both mean not ready yet, as in readOutput
      // (src/infra/ipc.ts).
      try {
        const output = JSON.parse(
          fs.readFileSync(outputPath, 'utf8'),
        ) as ContainerOutput;
        fs.unlinkSync(outputPath);
        return output;
      } catch {}
      if (child.exitCode !== null) break;
      await delay(20);
    }
    throw new Error(`Worker produced no IPC output: ${stderr}`);
  };

  return {
    /** Model requests of the media turn, without the warm-up. */
    mediaRequests: () =>
      requests.filter((request) => !isWarmUp(request.messages)),
    /** Tool-start progress lines, the ones the gateway parses. */
    toolStarts: () => stderr.match(/^\[tool\] read(?: \[[^\]]*\])*: /gm)?.length ?? 0,
    runMediaTurn: async (site: RequestSite): Promise<ContainerOutput> => {
      if (site === 'first') {
        child.stdin?.write(
          `${JSON.stringify({ ...base, ...mediaTurn, ipcAuthSecret })}\n`,
        );
        return waitOutput();
      }
      child.stdin?.write(`${JSON.stringify({ ...base, ipcAuthSecret })}\n`);
      expect((await waitOutput()).status).toBe('success');
      fs.writeFileSync(
        path.join(ipc, 'input.json'),
        encodeAuthenticatedInput(
          ipcAuthSecret,
          JSON.stringify({ ...base, ...mediaTurn }),
        ),
      );
      return waitOutput();
    },
  };
}

test.each<RequestSite>([
  'first',
  'follow-up',
])('a %s request that ran a tool is not re-run without native media', async (site) => {
  const worker = await startWorker((messages) => {
    const toolResult = messages.some((message) => message.role === 'tool');
    if (!toolResult) return READ_NOTES;
    return hasImagePart(messages)
      ? MEDIA_REJECTION
      : completion({ role: 'assistant', content: 'done' });
  });

  const output = await worker.runMediaTurn(site);

  expect(output.status).toBe('error');
  expect(output.error).toContain('image_url');
  expect(output.toolExecutions?.map((execution) => execution.name)).toEqual([
    'read',
  ]);
  expect(worker.toolStarts()).toBe(1);
  expect(
    worker.mediaRequests().map((request) => hasImagePart(request.messages)),
  ).toEqual([true, true]);
}, 60_000);

test.each<RequestSite>([
  'first',
  'follow-up',
])('a %s request rejected before any tool ran is retried without native media', async (site) => {
  const worker = await startWorker((messages) =>
    hasImagePart(messages)
      ? MEDIA_REJECTION
      : completion({ role: 'assistant', content: 'described from text' }),
  );

  const output = await worker.runMediaTurn(site);

  expect(output).toMatchObject({
    status: 'success',
    result: 'described from text',
  });
  const [rejected, retried, ...rest] = worker.mediaRequests();
  expect(rest).toEqual([]);
  expect(hasImagePart(rejected.messages)).toBe(true);
  expect(hasImagePart(retried.messages)).toBe(false);
  expect(correlationHeaders(rejected.headers)).toMatchObject({
    'x-hybridclaw-session-id': 'test-session',
  });
  expect(correlationHeaders(retried.headers)).toEqual(
    correlationHeaders(rejected.headers),
  );
}, 60_000);
