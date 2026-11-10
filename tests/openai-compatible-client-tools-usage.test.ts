import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  callModel: vi.fn(),
  callModelStream: vi.fn(),
  callWithProviderFallback: vi.fn(),
  enqueueTokenUsage: vi.fn(),
  resolveCost: vi.fn(),
}));

vi.mock('../src/gateway/openai-compatible-model.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/gateway/openai-compatible-model.js')
  >()),
  callOpenAICompatibleModel: mocks.callModel,
  callOpenAICompatibleModelStream: mocks.callModelStream,
}));
vi.mock('../src/gateway/provider-fallback.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/gateway/provider-fallback.js')
  >()),
  callWithProviderFallback: mocks.callWithProviderFallback,
}));
vi.mock('../src/providers/factory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/factory.js')>()),
  resolveModelRuntimeCredentials: async () => ({ provider: 'openai' }),
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
  enqueueTokenUsage: mocks.enqueueTokenUsage,
}));
vi.mock('../src/usage/model-cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/usage/model-cost.js')>()),
  resolveUsageCostUsdAfterMetadataRefresh: mocks.resolveCost,
}));

const { handleOpenAICompatibleChatCompletions } = await import(
  '../src/gateway/openai-compatible.js'
);

useCleanMocks({
  cleanup: () => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  },
});

const modelResult = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 40 },
  },
};

beforeEach(() => {
  mocks.callWithProviderFallback.mockImplementation(
    (params: {
      primaryRuntime: unknown;
      primaryModel: string;
      invoke: (runtime: unknown, model: string) => Promise<unknown>;
    }) => params.invoke(params.primaryRuntime, params.primaryModel),
  );
  mocks.callModel.mockResolvedValue(modelResult);
  mocks.callModelStream.mockResolvedValue(modelResult);
  mocks.resolveCost.mockResolvedValue(0.25);
});

function makeRequest(stream: boolean): IncomingMessage {
  const body = JSON.stringify({
    model: 'openai/gpt-test',
    stream,
    messages: [{ role: 'user', content: 'Look this up.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
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

test.each([
  { stream: false },
  { stream: true },
])('client-tools completion records one usage event (stream: $stream)', async ({
  stream,
}) => {
  const res = makeResponse();

  await handleOpenAICompatibleChatCompletions(makeRequest(stream), res);

  expect(res.statusCode).toBe(200);
  expect(mocks.enqueueTokenUsage).toHaveBeenCalledTimes(1);
  expect(mocks.enqueueTokenUsage).toHaveBeenCalledWith({
    sessionId: expect.stringContaining('main'),
    agentId: 'main',
    model: 'openai/gpt-test',
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    costUsd: 0.25,
  });
  expect(mocks.resolveCost).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'openai/gpt-test',
      usage: { promptTokens: 120, completionTokens: 30 },
    }),
  );
});

test.each([
  { stream: false },
  { stream: true },
])('usage names the fallback model that served the call (stream: $stream)', async ({
  stream,
}) => {
  mocks.callWithProviderFallback.mockImplementation(
    async (params: {
      primaryRuntime: unknown;
      primaryModel: string;
      invoke: (runtime: unknown, model: string) => Promise<unknown>;
    }) => {
      await params.invoke(params.primaryRuntime, params.primaryModel).catch(
        () => undefined,
      );
      return params.invoke(params.primaryRuntime, 'anthropic/fallback-test');
    },
  );
  const call = stream ? mocks.callModelStream : mocks.callModel;
  call.mockReset();
  call
    .mockRejectedValueOnce(new Error('rate limited'))
    .mockResolvedValueOnce(modelResult);

  await handleOpenAICompatibleChatCompletions(
    makeRequest(stream),
    makeResponse(),
  );

  expect(mocks.enqueueTokenUsage).toHaveBeenCalledTimes(1);
  expect(mocks.enqueueTokenUsage).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'anthropic/fallback-test' }),
  );
});

test('a streamed completion still records usage after the client disconnects', async () => {
  const res = makeResponse();
  mocks.callModelStream.mockImplementation(async () => {
    (res as unknown as { destroyed: boolean }).destroyed = true;
    return modelResult;
  });

  await handleOpenAICompatibleChatCompletions(makeRequest(true), res);

  expect(mocks.enqueueTokenUsage).toHaveBeenCalledTimes(1);
});
