import { beforeEach, describe, expect, test, vi } from 'vitest';
import { GatewayRequestError } from '../src/errors/gateway-request-error.ts';

const mocks = vi.hoisted(() => ({
  openAIKey: 'test-openai-key',
  hybridAIKey: '',
  baseUrl: 'https://speech.example.com/v1/',
  hybridAIBaseUrl: 'https://hybridai.example.com',
}));

vi.mock('../src/config/runtime-config.js', () => ({
  getRuntimeConfig: () => ({
    openai: { baseUrl: mocks.baseUrl },
  }),
}));

vi.mock('../src/config/config.js', () => ({
  get HYBRIDAI_BASE_URL() {
    return mocks.hybridAIBaseUrl;
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/providers/openai.js', () => ({
  readOpenAIAPIKey: () => mocks.openAIKey,
}));

vi.mock('../src/auth/hybridai-auth.js', () => ({
  readHybridAIApiKey: () => mocks.hybridAIKey || null,
}));

import {
  isWebchatSpeechAvailable,
  MAX_WEBCHAT_SPEECH_CHARS,
  synthesizeWebchatSpeech,
} from '../src/gateway/webchat-speech.ts';

const HYBRIDAI_ENDPOINT = 'https://hybridai.example.com/v1/audio/speech';
const OPENAI_ENDPOINT = 'https://speech.example.com/v1/audio/speech';

const EXPECTED_BODY = JSON.stringify({
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  input: 'Read this naturally.',
  response_format: 'mp3',
  speed: 1.15,
});

describe('webchat speech boundary', () => {
  beforeEach(() => {
    mocks.openAIKey = 'test-openai-key';
    mocks.hybridAIKey = '';
    mocks.baseUrl = 'https://speech.example.com/v1/';
    mocks.hybridAIBaseUrl = 'https://hybridai.example.com';
    vi.unstubAllGlobals();
  });

  test('generates MP3 audio without exposing the provider key', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(Buffer.from('mp3-bytes'), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      synthesizeWebchatSpeech({ text: '  Read this naturally.  ' }),
    ).resolves.toEqual(Buffer.from('mp3-bytes'));

    expect(fetchMock).toHaveBeenCalledWith(
      OPENAI_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-openai-key',
          'Content-Type': 'application/json',
        },
        body: EXPECTED_BODY,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  test('prefers HybridAI, the default provider, over OpenAI', async () => {
    mocks.hybridAIKey = 'test-hybridai-key';
    const fetchMock = vi.fn(async () => {
      return new Response(Buffer.from('mp3-bytes'), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      synthesizeWebchatSpeech({ text: 'Read this naturally.' }),
    ).resolves.toEqual(Buffer.from('mp3-bytes'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      HYBRIDAI_ENDPOINT,
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-hybridai-key',
          'Content-Type': 'application/json',
        },
        body: EXPECTED_BODY,
      }),
    );
  });

  test('speaks through HybridAI alone when no OpenAI key is configured', async () => {
    mocks.hybridAIKey = 'test-hybridai-key';
    mocks.openAIKey = '';
    const fetchMock = vi.fn(async () => {
      return new Response(Buffer.from('mp3-bytes'), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(isWebchatSpeechAvailable()).toBe(true);
    await expect(
      synthesizeWebchatSpeech({ text: 'Read this naturally.' }),
    ).resolves.toEqual(Buffer.from('mp3-bytes'));
    expect(fetchMock).toHaveBeenCalledWith(
      HYBRIDAI_ENDPOINT,
      expect.anything(),
    );
  });

  test('falls back to OpenAI when HybridAI cannot serve the request', async () => {
    // The rollout case: a HybridAI deployment without the audio routes yet.
    mocks.hybridAIKey = 'test-hybridai-key';
    const fetchMock = vi.fn(async (url: string) =>
      url === HYBRIDAI_ENDPOINT
        ? new Response('not found', { status: 404 })
        : new Response(Buffer.from('mp3-bytes'), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      synthesizeWebchatSpeech({ text: 'Read this naturally.' }),
    ).resolves.toEqual(Buffer.from('mp3-bytes'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(HYBRIDAI_ENDPOINT);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(OPENAI_ENDPOINT);
  });

  test('surfaces the failure when every backend fails', async () => {
    mocks.hybridAIKey = 'test-hybridai-key';
    const fetchMock = vi.fn(
      async () => new Response('provider-secret-detail', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      synthesizeWebchatSpeech({ text: 'valid text' }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 502,
      message: 'Speech generation failed.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not try the next backend after the client cancels', async () => {
    mocks.hybridAIKey = 'test-hybridai-key';
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      synthesizeWebchatSpeech({
        text: 'valid text',
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 499,
    });
    // Speaking through a second backend after Stop would defeat the Stop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reports unavailable speech without making a provider request', async () => {
    mocks.openAIKey = '';
    mocks.hybridAIKey = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(isWebchatSpeechAvailable()).toBe(false);
    await expect(
      synthesizeWebchatSpeech({ text: 'Hello' }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 503,
      message: 'Read aloud requires a HybridAI or OpenAI API key.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('bounds speech input and sanitizes upstream failures', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('provider-secret-detail', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      synthesizeWebchatSpeech({
        text: 'x'.repeat(MAX_WEBCHAT_SPEECH_CHARS + 1),
      }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 413,
    });
    await expect(
      synthesizeWebchatSpeech({ text: 'valid text' }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 502,
      message: 'Speech generation failed.',
    });
  });

  test('treats an empty provider response as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.alloc(0), { status: 200 })),
    );

    await expect(
      synthesizeWebchatSpeech({ text: 'valid text' }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 502,
      message: 'Speech generation returned no audio.',
    });
  });
});
