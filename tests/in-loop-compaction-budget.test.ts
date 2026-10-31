import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { createTokenUsageStats } from '../container/src/token-usage.js';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hc-compaction-budget-');
let workspace: string;
useCleanMocks({
  resetModules: true,
  unstubAllGlobals: true,
  unstubAllEnvs: true,
});
beforeEach(() => {
  workspace = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', '');
});

function history(): ChatMessage[] {
  return Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `Record ${index}: ${'made-up evidence '.repeat(80)}`,
  }));
}

async function compact(
  options: { configuredMax?: number; contextWindow?: number } = {},
) {
  let budget: number | undefined;
  let summaryPrompt = '';
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    budget = body.max_tokens;
    summaryPrompt = body.messages.at(-1).content;
    const complete = typeof budget === 'number' && budget > 1_024;
    return new Response(
      JSON.stringify({
        id: 'example-response',
        choices: [
          {
            message: {
              role: 'assistant',
              content: complete
                ? 'The pending decision and evidence are retained.'
                : 'Pending decision: ',
            },
            finish_reason: complete ? 'stop' : 'length',
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetch);
  const { compactInLoopWithModel } = await import(
    '../container/src/in-loop-compaction-runtime.js'
  );
  const messages = history();
  const original = structuredClone(messages);
  const usage = createTokenUsageStats();
  const context = {
    provider: 'openrouter' as const,
    model: 'openrouter/example-reasoning',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    chatbotId: '',
    contextWindow: options.contextWindow ?? 128_000,
  };
  const result = await compactInLoopWithModel({
    sessionId: 'session_a',
    history: messages,
    tools: [],
    tokenUsage: usage,
    fallbackContext: context,
    taskModels:
      options.configuredMax === undefined
        ? undefined
        : { compression: { ...context, maxTokens: options.configuredMax } },
  });
  expect(messages).toEqual(original);
  return { result, budget, summaryPrompt, fetch, usage };
}

test('reasoning has a bounded generation allowance separate from the concise summary target', async () => {
  const { result, budget, summaryPrompt } = await compact();
  expect(result.changed).toBe(true);
  expect(budget).toBeGreaterThan(1_024);
  expect(budget).toBeLessThanOrEqual(8_192);
  expect(summaryPrompt).toMatch(/\b1024\b/);
  const reference = String(result.history[4].content).split(
    'Original messages: ',
  )[1];
  const archived = JSON.parse(
    fs.readFileSync(path.join(workspace, reference), 'utf8'),
  );
  expect(archived.messages).toEqual(history().slice(4, 12));
});

test('an explicit compression budget is used instead of the summary target', async () => {
  const { result, budget } = await compact({ configuredMax: 4_096 });
  expect(result.changed).toBe(true);
  expect(budget).toBe(4_096);
});

test('an explicitly small budget stays small and a truncated reply never replaces evidence', async () => {
  const { result, budget } = await compact({ configuredMax: 512 });
  expect(budget).toBe(512);
  expect(result.changed).toBe(false);
  expect(fs.existsSync(path.join(workspace, '.hybridclaw-runtime'))).toBe(
    false,
  );
});

test('a smaller compression model bounds generation by the remaining context', async () => {
  const { budget, fetch } = await compact({ contextWindow: 8_192 });
  expect(fetch).toHaveBeenCalledOnce();
  expect(budget).toBeGreaterThan(1_024);
  expect(budget).toBeLessThan(8_192);
});

test('a compression model with no room for this input fails before a request', async () => {
  const { result, fetch, usage } = await compact({ contextWindow: 128 });
  expect(fetch).not.toHaveBeenCalled();
  expect(usage.modelCalls).toBe(0);
  expect(result.changed).toBe(false);
  expect(fs.existsSync(path.join(workspace, '.hybridclaw-runtime'))).toBe(
    false,
  );
});
