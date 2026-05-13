import { expect, test } from 'vitest';

import { callAnthropicProvider } from '../container/src/providers/anthropic.js';
import type { ChatMessage } from '../container/src/types.js';

const RUN_LIVE = process.env.HYBRIDCLAW_RUN_LIVE_ANTHROPIC_CACHE === '1';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const liveTest = RUN_LIVE && ANTHROPIC_API_KEY ? test : test.skip;

function longStaticSystemPrompt(): string {
  const paragraph =
    'You are HybridClaw in a prompt-cache verification run. Keep answers terse, deterministic, and focused only on acknowledging the cache probe. This repeated static text exists only to exceed Anthropic prompt-cache minimum token thresholds.';
  return Array.from({ length: 220 }, () => paragraph).join('\n');
}

function messagesForTurn(date: string, prompt: string): ChatMessage[] {
  return [
    { role: 'system', content: longStaticSystemPrompt() },
    {
      role: 'user',
      content: `<context>\nDate (UTC): ${date}\n</context>`,
    },
    { role: 'user', content: prompt },
  ];
}

liveTest(
  'Anthropic reads the cached static system prefix on turn 2 with dynamic context after it',
  async () => {
    const model =
      process.env.HYBRIDCLAW_LIVE_ANTHROPIC_MODEL ||
      'anthropic/claude-sonnet-4-6';
    const baseArgs = {
      provider: 'anthropic' as const,
      providerMethod: 'api-key',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: ANTHROPIC_API_KEY,
      model,
      chatbotId: '',
      enableRag: false,
      requestHeaders: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      },
      tools: [],
      maxTokens: 16,
      isLocal: false,
      contextWindow: 200_000,
      thinkingFormat: undefined,
    };

    const first = await callAnthropicProvider({
      ...baseArgs,
      messages: messagesForTurn('2026-05-13', 'Reply with "ok one".'),
    });
    expect(first.usage?.cache_creation_input_tokens ?? 0).toBeGreaterThan(0);

    const second = await callAnthropicProvider({
      ...baseArgs,
      messages: messagesForTurn('2026-05-14', 'Reply with "ok two".'),
    });
    expect(second.usage?.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
  },
  120_000,
);
