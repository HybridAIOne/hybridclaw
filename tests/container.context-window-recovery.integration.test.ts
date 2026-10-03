import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ChatMessage } from '../src/types/api.js';
import type { ContainerInput } from '../src/types/container.js';
import { runContainerWorker } from './helpers/container-worker.js';

interface Reply {
  status: number;
  body: unknown;
}

interface ModelServer {
  baseUrl: string;
  /** Messages of each agent-loop request, in order. */
  loopRequests: ChatMessage[][];
  summaryRequests: number;
  close: () => Promise<void>;
}

const CONTEXT_LENGTH_REJECTION: Reply = {
  status: 400,
  body: {
    error: {
      message:
        "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
      type: 'invalid_request_error',
      param: 'messages',
      code: 'context_length_exceeded',
    },
  },
};
const BIG_FILE = Array.from(
  { length: 200 },
  (_, line) => `line ${line} ${'x'.repeat(90)}`,
).join('\n');

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-context-recovery-'));
  fs.writeFileSync(path.join(workspace, 'big.txt'), BIG_FILE);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function completion(
  content: string | null,
  toolCalls?: NonNullable<ChatMessage['tool_calls']>,
): Reply {
  return {
    status: 200,
    body: {
      id: 'test',
      choices: [
        {
          message: {
            role: 'assistant',
            content,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls ? 'tool_calls' : 'stop',
        },
      ],
    },
  };
}

async function startModelServer(
  replyToLoop: (index: number) => Reply,
): Promise<ModelServer> {
  const loopRequests: ChatMessage[][] = [];
  let summaryRequests = 0;
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text) as {
      messages: ChatMessage[];
      tools?: unknown[];
    };
    // Only the agent loop sends tool schemas; compaction summaries do not.
    let reply: Reply;
    if (body.tools?.length) {
      loopRequests.push(body.messages);
      reply = replyToLoop(loopRequests.length - 1);
    } else {
      summaryRequests += 1;
      reply = completion('Earlier turns summarized.');
    }
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    loopRequests,
    get summaryRequests() {
      return summaryRequests;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

// Twenty earlier turns whose middle carries most of the estimate, so in-loop
// compaction has something to fold, then the current request.
function conversation(): ChatMessage[] {
  const messages: ChatMessage[] = Array.from({ length: 20 }, (_, turn) => ({
    role: turn % 2 === 0 ? 'user' : 'assistant',
    content:
      turn >= 4 && turn < 12
        ? `Turn ${turn} ${'earlier detail '.repeat(250)}`
        : `Turn ${turn}`,
  }));
  messages.push({ role: 'user', content: 'Read big.txt and summarize it.' });
  return messages;
}

async function runTurn(
  server: ModelServer,
  overrides: Partial<ContainerInput> = {},
) {
  return runContainerWorker(
    {
      sessionId: 'context-recovery',
      messages: conversation(),
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      provider: 'hybridai',
      model: 'test-model',
      chatbotId: 'test-bot',
      channelId: 'test-channel',
      enableRag: false,
      allowedTools: ['read'],
      skipContainerSystemPrompt: true,
      contextWindow: 128_000,
      ...overrides,
    },
    {
      HYBRIDCLAW_AGENT_WORKSPACE_ROOT: workspace,
      HYBRIDCLAW_AGENT_ALLOWED_ROOTS: JSON.stringify([workspace]),
    },
  );
}

describe('provider context-length rejections in the tool loop', () => {
  test('compacts, retries, and keeps the corrected budget for the rest of the turn', async () => {
    const server = await startModelServer((index) => {
      if (index === 0) return CONTEXT_LENGTH_REJECTION;
      if (index === 1) {
        return completion(null, [
          {
            id: 'read-big',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"big.txt"}' },
          },
        ]);
      }
      return completion('done');
    });
    try {
      const output = await runTurn(server);

      expect(output).toMatchObject({ status: 'success', result: 'done' });
      expect(server.loopRequests).toHaveLength(3);
      expect(server.summaryRequests).toBe(1);
      const [rejected, retried, afterTool] = server.loopRequests;
      expect(retried.length).toBeLessThan(rejected.length);
      expect(retried.at(-1)).toEqual(rejected.at(-1));
      // At the advertised 128k window this result would pass whole; the
      // budget lowered by the rejection still bounds it.
      const toolResult = afterTool.find((message) => message.role === 'tool');
      expect(String(toolResult?.content).length).toBeLessThan(
        BIG_FILE.length / 2,
      );
    } finally {
      await server.close();
    }
  }, 30_000);

  test('returns the provider error once the retry budget is spent', async () => {
    const server = await startModelServer(() => CONTEXT_LENGTH_REJECTION);
    try {
      const output = await runTurn(server);

      expect(output.status).toBe('error');
      expect(output.error).toContain('maximum context length is 8192 tokens');
      // The default budget allows three context retries after the first call.
      expect(server.loopRequests.length).toBeGreaterThan(1);
      expect(server.loopRequests.length).toBeLessThanOrEqual(4);
    } finally {
      await server.close();
    }
  }, 30_000);

  test.each([
    {
      name: 'the in-loop guard is disabled',
      reply: CONTEXT_LENGTH_REJECTION,
      overrides: {
        contextGuard: {
          enabled: false,
          compactionRatio: 0.75,
          overflowRatio: 0.9,
          maxRetries: 3,
        },
      },
      error: 'maximum context length is 8192 tokens',
    },
    {
      name: 'the rejection is not about context length',
      reply: {
        status: 400,
        body: {
          error: {
            message: "Invalid value for 'temperature'.",
            type: 'invalid_request_error',
            code: 'invalid_value',
          },
        },
      },
      overrides: {},
      error: "Invalid value for 'temperature'.",
    },
  ])('fails without retrying when $name', async ({ reply, overrides, error }) => {
    const server = await startModelServer(() => reply);
    try {
      const output = await runTurn(server, overrides);

      expect(output.status).toBe('error');
      expect(output.error).toContain(error);
      expect(server.loopRequests).toHaveLength(1);
      expect(server.summaryRequests).toBe(0);
    } finally {
      await server.close();
    }
  }, 30_000);
});
