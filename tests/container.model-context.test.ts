import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';
import type { AuxiliaryTaskContext } from '../container/src/providers/auxiliary.js';
import type { TaskModelPolicies } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-model-context-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
  unmock: ['node:child_process'],
});

async function loadTools(context: AuxiliaryTaskContext) {
  const root = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_SANDBOX_MODE', 'host');
  const imagePath = path.join(root, 'image.jpg');
  fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const transcripts = path.join(root, '.session-transcripts');
  fs.mkdirSync(transcripts);
  fs.writeFileSync(
    path.join(transcripts, 'session-a.jsonl'),
    `${JSON.stringify({ sessionId: 'session-a', role: 'user', content: 'Release plan' })}\n`,
  );
  const tools = await import('../container/src/tools.js');
  const { setModelContext, setTaskModelPolicies } = await import(
    '../container/src/model-context.js'
  );
  setModelContext(context);
  setTaskModelPolicies(undefined);
  tools.setGatewayContext(
    'http://gateway.test',
    'test-token',
    undefined,
    undefined,
    'managed-cloud',
  );
  return {
    tools,
    args: {
      image_url: imagePath,
      question: 'What is visible?',
      query: 'release',
      useLlmSummary: true,
    },
  };
}

function expectToolAnswer(toolName: string, output: string, answer: string) {
  const result = JSON.parse(output);
  expect(
    toolName === 'session_search' ? result.results[0].summary : result.analysis,
  ).toBe(answer);
}

const toolNames = [
  'vision_analyze',
  'browser_vision',
  'session_search',
] as const;

test.each(toolNames)(
  '%s uses claude-cli without an API key or task override',
  async (toolName) => {
    const spawnMock = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => {
        child.stdout.end(
          `${JSON.stringify({ type: 'result', result: 'CLI answer' })}\n`,
        );
        child.emit('close', 0);
      });
      return child;
    });
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn: spawnMock,
    }));
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ imageBase64: 'aW1hZ2U=' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { tools, args } = await loadTools({
      provider: 'anthropic',
      providerMethod: 'claude-cli',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: '',
      model: 'anthropic/claude-sonnet-4-6',
      chatbotId: '',
    });

    const result = await tools.executeToolWithMetadata(
      toolName,
      JSON.stringify(args),
    );

    expect(result.isError, result.output).toBe(false);
    expectToolAnswer(toolName, result.output, 'CLI answer');
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
      'claude',
      expect.arrayContaining(['--model', 'claude-sonnet-4-6']),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledTimes(
      toolName === 'browser_vision' ? 1 : 0,
    );
  },
);

test.each(
  toolNames.flatMap((toolName) => [
    { toolName, format: 'modelBehavior' as const },
    { toolName, format: 'thinkingFormat' as const },
  ]),
)(
  '$toolName preserves local thinking parsing from $format',
  async ({ toolName, format }) => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === 'http://gateway.test/api/browser/tool') {
          return new Response(JSON.stringify({ imageBase64: 'aW1hZ2U=' }));
        }
        expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'test-model',
        });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '<think>Private reasoning</think>Visible answer',
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { tools, args } = await loadTools({
      provider: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'vllm/test-model',
      chatbotId: '',
      isLocal: true,
      contextWindow: 32768,
      ...(format === 'modelBehavior'
        ? { modelBehavior: { thinkingFormat: 'qwen' } }
        : { thinkingFormat: 'qwen' }),
    });
    const router = await import('../container/src/providers/router.js');
    const routedCall = vi.spyOn(
      router,
      toolName === 'session_search'
        ? 'callRoutedModel'
        : 'callVisionProviderModel',
    );

    const result = await tools.executeToolWithMetadata(
      toolName,
      JSON.stringify(args),
    );

    expect(result.isError).toBe(false);
    expectToolAnswer(toolName, result.output, 'Visible answer');
    expect(routedCall).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocal: true,
        contextWindow: 32768,
        ...(format === 'modelBehavior'
          ? { modelBehavior: { thinkingFormat: 'qwen' } }
          : { thinkingFormat: 'qwen' }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(
      toolName === 'browser_vision' ? 2 : 1,
    );
  },
);

test('routing snapshots keep headers and policies across request replacement', async () => {
  const {
    setModelContext,
    setTaskModelPolicies,
    captureAuxiliaryRuntimeContext,
  } = await import('../container/src/model-context.js');
  const context: AuxiliaryTaskContext = {
    provider: 'anthropic',
    providerMethod: 'claude-cli',
    baseUrl: ' https://api.anthropic.com/v1/ ',
    apiKey: '',
    model: ' anthropic/claude-sonnet-4-6 ',
    chatbotId: '',
    requestHeaders: { 'X-Route': 'first' },
    maxTokens: 321.9,
    isLocal: false,
    contextWindow: 32768,
    debugModelResponses: true,
    modelBehavior: { thinkingFormat: 'qwen' },
    thinkingFormat: 'qwen',
  };
  const policies: TaskModelPolicies = {
    vision: {
      provider: 'vllm',
      model: 'vllm/vision-model',
      requestHeaders: { 'X-Route': 'vision' },
    },
  };
  setModelContext(context);
  setTaskModelPolicies(policies);
  context.requestHeaders!['X-Route'] = 'changed';
  policies.vision!.requestHeaders!['X-Route'] = 'changed';
  const snapshot = captureAuxiliaryRuntimeContext();
  expect(snapshot.fallbackContext).toEqual({
    ...context,
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'anthropic/claude-sonnet-4-6',
    requestHeaders: { 'X-Route': 'first' },
    maxTokens: 321,
  });
  expect(snapshot.taskModels?.vision?.requestHeaders).toEqual({
    'X-Route': 'vision',
  });
  snapshot.fallbackContext.requestHeaders!['X-Route'] = 'snapshot';
  snapshot.taskModels!.vision!.requestHeaders!['X-Route'] = 'snapshot';
  expect(
    captureAuxiliaryRuntimeContext().fallbackContext.requestHeaders,
  ).toEqual({ 'X-Route': 'first' });
  expect(
    captureAuxiliaryRuntimeContext().taskModels?.vision?.requestHeaders,
  ).toEqual({ 'X-Route': 'vision' });

  setModelContext({
    provider: undefined,
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    model: 'vllm/next',
    chatbotId: '',
  });
  setTaskModelPolicies(undefined);
  const next = captureAuxiliaryRuntimeContext();
  expect(next.fallbackContext).toMatchObject({
    provider: 'vllm',
    model: 'vllm/next',
  });
  expect(next.fallbackContext.providerMethod).toBeUndefined();
  expect(next.fallbackContext.thinkingFormat).toBeUndefined();
  expect(next.taskModels).toBeUndefined();
  expect(snapshot.fallbackContext.providerMethod).toBe('claude-cli');
  expect(snapshot.taskModels?.vision?.model).toBe('vllm/vision-model');
});
