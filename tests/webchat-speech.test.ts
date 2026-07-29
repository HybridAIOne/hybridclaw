import { beforeEach, describe, expect, test, vi } from 'vitest';
import { GatewayRequestError } from '../src/errors/gateway-request-error.ts';

const mocks = vi.hoisted(() => ({
  apiKey: 'test-openai-key',
  baseUrl: 'https://speech.example.com/v1/',
}));

vi.mock('../src/config/runtime-config.js', () => ({
  getRuntimeConfig: () => ({
    openai: { baseUrl: mocks.baseUrl },
  }),
}));

vi.mock('../src/providers/openai.js', () => ({
  readOpenAIAPIKey: () => mocks.apiKey,
}));

import {
  isWebchatSpeechAvailable,
  MAX_WEBCHAT_SPEECH_CHARS,
  synthesizeWebchatSpeech,
} from '../src/gateway/webchat-speech.ts';

describe('webchat speech boundary', () => {
  beforeEach(() => {
    mocks.apiKey = 'test-openai-key';
    mocks.baseUrl = 'https://speech.example.com/v1/';
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
      'https://speech.example.com/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-openai-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          voice: 'alloy',
          input: 'Read this naturally.',
          response_format: 'mp3',
          speed: 1.15,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  test('reports unavailable speech without making a provider request', async () => {
    mocks.apiKey = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(isWebchatSpeechAvailable()).toBe(false);
    await expect(
      synthesizeWebchatSpeech({ text: 'Hello' }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 503,
      message: 'Read aloud requires an OpenAI API key.',
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
