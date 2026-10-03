import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createTokenUsageStats } from '../container/src/token-usage.js';
import type { ChatMessage, ToolDefinition } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const runtime = vi.hoisted(() => ({ workspace: '' }));
vi.mock('../container/src/runtime-paths.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../container/src/runtime-paths.js')
  >()),
  get WORKSPACE_ROOT() {
    return runtime.workspace;
  },
}));
const makeTempDir = useTempDir();
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllGlobals: true,
});
beforeEach(() => {
  runtime.workspace = makeTempDir('hc-compaction-runtime-');
});

const readTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

function history(): ChatMessage[] {
  const messages: ChatMessage[] = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index}: ${'x'.repeat(2_000)}`,
  }));
  messages[4] = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_a',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"example.txt"}' },
      },
    ],
  };
  messages[5] = {
    role: 'tool',
    tool_call_id: 'call_a',
    content: `Complete evidence: ${'y'.repeat(40_000)}`,
  };
  return messages;
}

describe('in-loop compaction model routing', () => {
  test.each([
    {
      provider: 'anthropic' as const,
      model: 'anthropic/claude-sonnet-4-6',
      baseUrl: 'https://api.anthropic.com',
      knownTool: true,
    },
    {
      provider: 'anthropic' as const,
      model: 'anthropic/claude-sonnet-4-6',
      baseUrl: 'https://api.anthropic.com',
      knownTool: false,
    },
    {
      provider: 'gemini' as const,
      model: 'gemini/gemini-2.5-pro',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      knownTool: true,
    },
  ])(
    'supplies historical schemas and complete evidence through $provider (known schema=$knownTool)',
    async ({ provider, model, baseUrl, knownTool }) => {
      const { applyContextGuard } = await import(
        '../container/src/context-guard.js'
      );
      const { compactInLoopWithModel } = await import(
        '../container/src/in-loop-compaction-runtime.js'
      );
      const messages = history();
      const original = structuredClone(messages);
      expect(
        applyContextGuard({ history: messages, contextWindowTokens: 8_192 })
          .tier3Triggered,
      ).toBe(true);
      const fetch = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as {
            tools: unknown[];
            messages: Array<{
              role: string;
              content: string | Array<Record<string, unknown>>;
            }>;
          };
          if (provider === 'anthropic') {
            expect(body.tools).toEqual([
              expect.objectContaining({
                name: 'read',
                input_schema: expect.objectContaining({ type: 'object' }),
              }),
            ]);
            const use = body.messages
              .flatMap((message) =>
                Array.isArray(message.content) ? message.content : [],
              )
              .find((block) => block.type === 'tool_use');
            const result = body.messages
              .flatMap((message) =>
                Array.isArray(message.content) ? message.content : [],
              )
              .find((block) => block.type === 'tool_result');
            expect(use).toMatchObject({
              id: 'call_a',
              name: 'read',
              input: { path: 'example.txt' },
            });
            expect(result).toMatchObject({
              tool_use_id: 'call_a',
              content: original[5].content,
            });
          } else {
            expect(body.tools).toEqual([readTool]);
            expect(body.messages.slice(0, -1)).toEqual(original.slice(4, 12));
          }
          return new Response(
            JSON.stringify(
              provider === 'anthropic'
                ? {
                    id: 'test',
                    model,
                    role: 'assistant',
                    stop_reason: 'end_turn',
                    content: [{ type: 'text', text: 'Evidence retained.' }],
                  }
                : {
                    id: 'test',
                    model,
                    choices: [
                      {
                        message: {
                          role: 'assistant',
                          content: 'Evidence retained.',
                        },
                        finish_reason: 'stop',
                      },
                    ],
                  },
            ),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
      );
      vi.stubGlobal('fetch', fetch);
      const usage = createTokenUsageStats();
      const result = await compactInLoopWithModel({
        sessionId: 'session_a',
        history: messages,
        tools: knownTool ? [readTool] : [],
        tokenUsage: usage,
        taskModels: {
          compression: {
            provider,
            model,
            baseUrl,
            apiKey: 'test-key',
            chatbotId: '',
            contextWindow: 128_000,
          },
        },
        fallbackContext: {
          provider: 'hybridai',
          model: 'fallback',
          baseUrl: 'https://example.com',
          apiKey: 'test-key',
          chatbotId: 'test-bot',
        },
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(result.changed).toBe(true);
      expect(messages).toEqual(original);
      expect(usage.modelCalls).toBe(1);
      const archive = String(result.history[4].content).split(
        'Original messages: ',
      )[1];
      expect(
        JSON.parse(
          fs.readFileSync(path.join(runtime.workspace, archive), 'utf8'),
        ).messages,
      ).toEqual(original.slice(4, 12));
    },
  );

  test.each(['anthropic', 'gemini', 'openai'] as const)(
    'rejects a length-truncated summary through the $provider adapter',
    async (provider) => {
      const { compactInLoopWithModel } = await import(
        '../container/src/in-loop-compaction-runtime.js'
      );
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify(
                provider === 'anthropic'
                  ? {
                      id: 'test',
                      role: 'assistant',
                      stop_reason: 'max_tokens',
                      content: [{ type: 'text', text: 'Pending decision: ' }],
                    }
                  : provider === 'openai'
                    ? {
                        id: 'test',
                        status: 'incomplete',
                        incomplete_details: { reason: 'max_output_tokens' },
                        output_text: 'Pending decision: ',
                        output: [],
                      }
                    : {
                        id: 'test',
                        choices: [
                          {
                            message: {
                              role: 'assistant',
                              content: 'Pending decision: ',
                            },
                            finish_reason: 'length',
                          },
                        ],
                      },
              ),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        ),
      );
      const messages = history();
      const result = await compactInLoopWithModel({
        sessionId: 'session_a',
        history: messages,
        tools: [readTool],
        tokenUsage: createTokenUsageStats(),
        fallbackContext: {
          provider,
          model:
            provider === 'anthropic'
              ? 'anthropic/claude-sonnet-4-6'
              : 'test-model',
          baseUrl: 'https://example.com/v1',
          apiKey: 'test-key',
          chatbotId: '',
        },
      });
      expect(result.history).toBe(messages);
      expect(result.changed).toBe(false);
      expect(log).toHaveBeenLastCalledWith(
        '[context] in-loop compaction skipped reason=summary_truncated',
      );
      expect(
        fs.existsSync(path.join(runtime.workspace, '.hybridclaw-runtime')),
      ).toBe(false);
    },
  );
});
