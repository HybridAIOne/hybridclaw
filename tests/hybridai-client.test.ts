import { afterEach, expect, test, vi } from 'vitest';

import {
  callHybridAI,
  callHybridAIStream,
} from '../container/src/hybridai-client.js';

const okResponse = {
  id: 'resp_1',
  model: 'gpt-5-nano',
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'ok',
      },
      finish_reason: 'stop',
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

test('callHybridAI forwards max_tokens when provided', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.max_tokens).toBe(4096);
    return new Response(JSON.stringify(okResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await callHybridAI(
    'https://hybridai.one',
    'test-key',
    'gpt-5-nano',
    'bot_1',
    true,
    [{ role: 'user', content: 'hello' }],
    [],
    4096,
  );

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callHybridAI omits max_tokens when not provided', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.max_tokens).toBeUndefined();
    return new Response(JSON.stringify(okResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  await callHybridAI(
    'https://hybridai.one',
    'test-key',
    'gpt-5-nano',
    'bot_1',
    true,
    [{ role: 'user', content: 'hello' }],
    [],
  );

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callHybridAIStream forwards stream and max_tokens', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(1024);
    return new Response(JSON.stringify(okResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await callHybridAIStream(
    'https://hybridai.one',
    'test-key',
    'gpt-5-nano',
    'bot_1',
    true,
    [{ role: 'user', content: 'hello' }],
    [],
    () => {},
    1024,
  );

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
