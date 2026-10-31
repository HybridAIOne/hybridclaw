import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { compactInLoop } from '../container/src/in-loop-compaction.js';
import {
  createTokenUsageStats,
  estimateMessageTokens,
} from '../container/src/token-usage.js';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('hc-compaction-region-');
let workspace: string;
useCleanMocks({
  resetModules: true,
  unstubAllGlobals: true,
  unstubAllEnvs: true,
});
beforeEach(() => {
  workspace = temp();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', '');
});

test.each([600, 10_000])(
  'never splits a parallel exchange to satisfy an input budget (%i chars per result)',
  async (size) => {
    const edge: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `Context ${index}`,
    }));
    const exchange = (batch: number): ChatMessage[] => {
      const calls = Array.from({ length: 8 }, (_, index) => ({
        id: `batch-${batch}-${index}`,
        type: 'function' as const,
        function: { name: 'read', arguments: '{}' },
      }));
      return [
        { role: 'assistant', content: null, tool_calls: calls },
        ...calls.map(
          (call): ChatMessage => ({
            role: 'tool',
            tool_call_id: call.id,
            content: 'x'.repeat(size),
          }),
        ),
      ];
    };
    const first = exchange(1);
    const history = [
      ...edge.slice(0, 4),
      ...first,
      ...exchange(2),
      ...edge.slice(4),
    ];
    const summarize = vi.fn(async (input: ChatMessage[]) => {
      expect(input.slice(0, -1)).toEqual(first);
      return {
        choices: [
          {
            message: {
              role: 'assistant' as const,
              content: 'First batch retained in the archive.',
            },
            finish_reason: 'stop' as const,
          },
        ],
      };
    });
    const archive = vi.fn();
    const result = await compactInLoop({
      history,
      summarize,
      archive: { path: 'archive.json', write: archive },
      inputFits: (messages) => estimateMessageTokens(messages) < 3_500,
    });
    if (size === 600) {
      expect(result.changed).toBe(true);
      expect(result.compactedMessages).toBe(9);
      expect(result.history.slice(5)).toEqual(history.slice(13));
      expect(archive).toHaveBeenCalledExactlyOnceWith(first);
    } else {
      expect(result.history).toBe(history);
      expect(summarize).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
    }
  },
);

test('fits a complete subregion to the compression model and retains every other message', async () => {
  const history: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `Evidence ${index}: ${'unabridged detail '.repeat(200)}`,
  }));
  const original = structuredClone(history);
  let summarized: ChatMessage[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    summarized = body.messages.slice(0, -1);
    expect(body.max_tokens).toBe(4_096);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Evidence and pending decisions retained.',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const { compactInLoopWithModel } = await import(
    '../container/src/in-loop-compaction-runtime.js'
  );
  const result = await compactInLoopWithModel({
    sessionId: 'session_a',
    history,
    tools: [],
    tokenUsage: createTokenUsageStats(),
    taskModels: {
      compression: {
        provider: 'openrouter',
        model: 'example-small',
        baseUrl: 'https://example.com/v1',
        apiKey: 'test-key',
        contextWindow: 12_000,
        maxTokens: 4_096,
      },
    },
    fallbackContext: {
      provider: 'openrouter',
      model: 'example-primary',
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      chatbotId: '',
      contextWindow: 128_000,
    },
  });
  expect(result.changed).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(summarized.length).toBeGreaterThan(0);
  expect(summarized.length).toBeLessThan(28);
  expect(summarized).toEqual(original.slice(4, 4 + summarized.length));
  expect(result.history.slice(0, 4)).toEqual(original.slice(0, 4));
  expect(result.history.slice(5)).toEqual(
    original.slice(4 + summarized.length),
  );
  const archive = String(result.history[4].content).split(
    'Original messages: ',
  )[1];
  expect(
    JSON.parse(fs.readFileSync(path.join(workspace, archive), 'utf8')).messages,
  ).toEqual(summarized);
  expect(history).toEqual(original);
});
