import { expect, test, vi } from 'vitest';
import { toolResultDigest } from '@hybridclaw/shared/tool-history';
import {
  callRoutedModel,
  callRoutedModelStream,
} from '../container/src/providers/router.js';
import type { ChatMessage } from '../container/src/types.js';
import { isContainerOutput } from '../src/infra/ipc-output-validation.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true, restoreAllMocks: true });

test.each(['hybridai', 'vllm'] as const)(
  'retains internal identity while sending only model protocol fields (%s)',
  async (provider) => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        tool_call_id: 'sample',
        content: 'bounded result',
        resultDigest: toolResultDigest('full result'),
      },
    ];
    const snapshot = structuredClone(messages);
    const received: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: ChatMessage[];
        };
        received.push(body.messages);
        expect(JSON.stringify(body.messages)).not.toContain('resultDigest');
        expect(body.messages[0].content).toBe('bounded result');
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'done' },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const context = {
      provider,
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'test-key',
      model: 'sample-model',
      chatbotId: 'sample-bot',
      messages,
      tools: [],
    };
    await callRoutedModel(context);
    await callRoutedModelStream({ ...context, onTextDelta: () => {} });
    expect(received).toHaveLength(2);
    expect(messages).toEqual(snapshot);
  },
);

test.each(['invalid', 'A'.repeat(64), '../outside', 1, null])(
  'IPC refuses malformed result identities: %j',
  (resultDigest) => {
    expect(
      isContainerOutput({
        status: 'success',
        result: 'ok',
        toolsUsed: ['read'],
        toolExecutions: [
          {
            name: 'read',
            arguments: '{}',
            result: 'reference',
            toolCallId: 'sample',
            durationMs: 0,
            resultDigest,
          },
        ],
      }),
    ).toBe(false);
  },
);
