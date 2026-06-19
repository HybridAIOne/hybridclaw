import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { callHybridAIProvider } from '../container/src/providers/hybridai.js';
import type { NormalizedCallArgs } from '../container/src/providers/shared.js';

function makeArgs(
  overrides: Partial<NormalizedCallArgs> = {},
): NormalizedCallArgs {
  return {
    provider: 'hybridai',
    baseUrl: 'https://api.hybridai.test',
    apiKey: 'test-key',
    model: 'gpt-4.1-mini',
    chatbotId: '',
    enableRag: false,
    requestHeaders: undefined,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: undefined,
    isLocal: false,
    contextWindow: undefined,
    thinkingFormat: undefined,
    ...overrides,
  };
}

describe('provider prompt debug logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('does not emit last prompt debug records when model response debug is off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_1',
            model: 'gpt-4.1-mini',
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }),
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await callHybridAIProvider(makeArgs({ debugModelResponses: false }));

    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining('[last-prompt-file]'),
    );
  });

  test('emits last prompt debug records when model response debug is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_1',
            model: 'gpt-4.1-mini',
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }),
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await callHybridAIProvider(makeArgs({ debugModelResponses: true }));

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('[last-prompt-file]'),
    );
  });

  test('signs HybridClaw instance requests when auth secret is available', async () => {
    vi.stubEnv('HYBRIDCLAW_AUTH_SECRET', 'hybridclaw-secret');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        const bodyText = String(init?.body || '');
        const timestamp = headers['X-HybridClaw-Timestamp'];
        const nonce = headers['X-HybridClaw-Nonce'];
        const bodyHash = createHash('sha256')
          .update(bodyText, 'utf8')
          .digest('hex');
        const expectedSignature = createHmac('sha256', 'hybridclaw-secret')
          .update(
            ['POST', '/v1/chat/completions', bodyHash, timestamp, nonce].join(
              '\n',
            ),
            'utf8',
          )
          .digest('hex');

        expect(headers['X-HybridClaw-Session-Id']).toBe('sess_test');
        expect(headers['X-HybridClaw-Agent-Id']).toBe('bob5');
        expect(Number(timestamp)).toBeGreaterThan(0);
        expect(nonce).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect(headers['X-HybridClaw-Signature']).toBe(expectedSignature);

        return new Response(
          JSON.stringify({
            id: 'chatcmpl_1',
            model: 'gpt-4.1-mini',
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }),
    );

    await callHybridAIProvider(
      makeArgs({
        sessionId: 'sess_test',
        agentId: 'bob5',
      }),
    );
  });
});
