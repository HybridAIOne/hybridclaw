import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

const codexRuntime = {
  provider: 'openai-codex' as const,
  apiKey: 'test-key',
  baseUrl: 'https://codex.example.com/backend-api/codex',
  chatbotId: '',
  enableRag: false,
  requestHeaders: {},
  agentId: 'main',
  isLocal: false,
  contextWindow: 200_000,
  thinkingFormat: undefined,
};

vi.mock('../src/providers/factory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/factory.js')>()),
  resolveModelRuntimeCredentials: async () => codexRuntime,
}));
vi.mock('../src/providers/task-routing.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/providers/task-routing.js')
  >()),
  resolveTaskModelPolicy: async () => undefined,
}));
vi.mock('../src/gateway/provider-fallback.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/gateway/provider-fallback.js')
  >()),
  callWithProviderFallback: (params: {
    primaryRuntime: unknown;
    primaryModel: string;
    invoke: (runtime: unknown, model: string) => Promise<unknown>;
  }) => params.invoke(params.primaryRuntime, params.primaryModel),
}));
vi.mock('../src/agents/agent-registry.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/agents/agent-registry.js')
  >()),
  resolveAgentForRequest: () => ({
    agentId: 'main',
    model: 'openai-codex/gpt-test',
    chatbotId: '',
  }),
}));
vi.mock('../src/memory/memory-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/memory/memory-service.js')>();
  return {
    ...actual,
    memoryService: {
      ...actual.memoryService,
      getOrCreateSession: vi.fn(),
      storeMessage: vi.fn(),
    },
  };
});
vi.mock('../src/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/workspace.js')>()),
  ensureBootstrapFiles: vi.fn(),
}));
vi.mock('../src/agent/conversation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/conversation.js')>()),
  buildConversationContext: () => ({
    messages: [{ role: 'system', content: 'system prompt' }],
  }),
}));
vi.mock('../src/config/runtime-config.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/config/runtime-config.js')
  >()),
  resolveDefaultAgentId: () => 'main',
}));
vi.mock('../src/usage/token-usage-buffer.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/usage/token-usage-buffer.js')
  >()),
  enqueueTokenUsage: vi.fn(),
}));
vi.mock('../src/usage/model-cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/usage/model-cost.js')>()),
  resolveUsageCostUsdAfterMetadataRefresh: async () => 0,
}));

const { handleOpenAICompatibleChatCompletions } = await import(
  '../src/gateway/openai-compatible.js'
);
const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');

useCleanMocks({
  unstubAllGlobals: true,
  cleanup: () => mocks.fetch.mockReset(),
});

beforeEach(() => {
  mocks.fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'gpt-test',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', mocks.fetch);
});

type EndpointMode = 'tools' | 'tools-stream' | 'decision';

function makeRequest(mode: EndpointMode, user?: string): IncomingMessage {
  const body = JSON.stringify({
    model: mode === 'decision' ? 'regular' : 'openai-codex/gpt-test',
    stream: mode === 'tools-stream',
    ...(user === undefined ? {} : { user }),
    messages: [{ role: 'user', content: 'Look this up.' }],
    ...(mode === 'decision'
      ? {}
      : {
          tools: [
            {
              type: 'function',
              function: {
                name: 'lookup',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
        }),
  });
  return Object.assign(Readable.from([Buffer.from(body)]), {
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

function makeResponse(): ServerResponse & { statusCode?: number } {
  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead: vi.fn((status: number) => {
      res.statusCode = status;
      res.headersSent = true;
    }),
    write: vi.fn(),
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
    statusCode: undefined as number | undefined,
  };
  return res as unknown as ServerResponse & { statusCode?: number };
}

async function sendEndpointRequest(
  mode: EndpointMode,
  user?: string,
): Promise<{ raw: string; body: Record<string, unknown> }> {
  const res = makeResponse();
  await handleOpenAICompatibleChatCompletions(makeRequest(mode, user), res);
  expect(res.statusCode).toBe(200);
  const init = mocks.fetch.mock.calls.at(-1)?.[1] as RequestInit;
  const raw = String(init.body);
  return { raw, body: JSON.parse(raw) as Record<string, unknown> };
}

const endpointModes = [
  { mode: 'tools' as const },
  { mode: 'tools-stream' as const },
  { mode: 'decision' as const },
];

test.each(endpointModes)('a client user yields a stable, hashed prompt_cache_key ($mode)', async ({
  mode,
}) => {
  const first = await sendEndpointRequest(mode, 'user_a');
  const second = await sendEndpointRequest(mode, 'user_a');

  expect(first.body.prompt_cache_key).toMatch(/^hybridclaw-[0-9a-f]{32}$/);
  expect(second.body.prompt_cache_key).toBe(first.body.prompt_cache_key);
  expect(first.raw).not.toContain('user_a');
});

test.each(endpointModes)('different client users get different keys ($mode)', async ({
  mode,
}) => {
  const a = await sendEndpointRequest(mode, 'user_a');
  const b = await sendEndpointRequest(mode, 'user_b');

  expect(a.body.prompt_cache_key).not.toBe(b.body.prompt_cache_key);
});

test.each(endpointModes)('no client user sends no prompt_cache_key ($mode)', async ({
  mode,
}) => {
  const { body } = await sendEndpointRequest(mode);

  expect(body).not.toHaveProperty('prompt_cache_key');
});

async function sendAuxiliaryRequest(
  task: 'compression' | 'session_search',
  agentId: string,
  content: string,
): Promise<Record<string, unknown>> {
  await callAuxiliaryModel({
    task,
    agentId,
    provider: 'openai-codex',
    model: 'gpt-test',
    messages: [{ role: 'user', content }],
  });
  const init = mocks.fetch.mock.calls.at(-1)?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

test.each([
  { task: 'compression' as const },
  { task: 'session_search' as const },
])('auxiliary $task calls share one key across sessions', async ({ task }) => {
  const a = await sendAuxiliaryRequest(task, 'agent_a', 'First transcript.');
  const b = await sendAuxiliaryRequest(task, 'agent_b', 'Second transcript.');

  expect(a.prompt_cache_key).toBe(`hybridclaw-aux-${task}`);
  expect(b.prompt_cache_key).toBe(a.prompt_cache_key);
});

test('different auxiliary tasks get different keys', async () => {
  const compression = await sendAuxiliaryRequest('compression', 'main', 'x');
  const review = await sendAuxiliaryRequest('session_search', 'main', 'x');

  expect(compression.prompt_cache_key).not.toBe(review.prompt_cache_key);
});
