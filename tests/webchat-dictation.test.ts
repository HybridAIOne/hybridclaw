import fs from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { GatewayRequestError } from '../src/errors/gateway-request-error.ts';

const mocks = vi.hoisted(() => ({
  enabled: true,
  resolveModels: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock('../src/config/runtime-config.js', () => ({
  getRuntimeConfig: () => ({
    media: {
      audio: {
        enabled: mocks.enabled,
        maxBytes: 20 * 1024 * 1024,
        maxFiles: 4,
        maxCharsPerTranscript: 8_000,
        maxTotalChars: 16_000,
        timeoutMs: 60_000,
        prompt: 'Transcribe the audio.',
        language: '',
        models: [],
      },
    },
  }),
}));

vi.mock('../src/media/audio-transcription-backends.js', () => ({
  resolveAudioTranscriptionModels: mocks.resolveModels,
  transcribeAudioWithFallback: mocks.transcribe,
}));

import {
  isSupportedDictationMimeType,
  transcribeWebchatDictation,
} from '../src/gateway/webchat-dictation.ts';

describe('webchat dictation boundary', () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.resolveModels.mockReset();
    mocks.resolveModels.mockResolvedValue([
      { type: 'provider', provider: 'openai' },
    ]);
    mocks.transcribe.mockReset();
  });

  test('transcribes from a private temporary file and deletes it afterwards', async () => {
    let capturedPath = '';
    mocks.transcribe.mockImplementation(
      async (params: {
        filePath: string;
        mimeType: string;
        abortSignal?: AbortSignal;
      }) => {
        capturedPath = params.filePath;
        const stat = await fs.stat(params.filePath);
        expect(stat.mode & 0o777).toBe(0o600);
        expect(await fs.readFile(params.filePath, 'utf8')).toBe('voice-bytes');
        expect(params.mimeType).toBe('audio/mp4');
        return { text: '  dictated text  ', backend: 'test' };
      },
    );

    const abortController = new AbortController();
    await expect(
      transcribeWebchatDictation({
        audio: Buffer.from('voice-bytes'),
        mimeType: 'audio/mp4; codecs=mp4a.40.2',
        abortSignal: abortController.signal,
      }),
    ).resolves.toBe('dictated text');

    expect(mocks.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'dictation.m4a',
        abortSignal: abortController.signal,
      }),
    );
    await expect(fs.access(path.dirname(capturedPath))).rejects.toThrow();
  });

  test('deletes temporary audio when transcription fails', async () => {
    let capturedPath = '';
    mocks.transcribe.mockImplementation(
      async (params: { filePath: string }) => {
        capturedPath = params.filePath;
        return null;
      },
    );

    await expect(
      transcribeWebchatDictation({
        audio: Buffer.from('silence'),
        mimeType: 'audio/webm',
      }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 502,
    });
    await expect(fs.access(path.dirname(capturedPath))).rejects.toThrow();
  });

  test('reports an empty transcript as no detected speech', async () => {
    mocks.transcribe.mockResolvedValue({ text: '   ', backend: 'test' });

    await expect(
      transcribeWebchatDictation({
        audio: Buffer.from('silence'),
        mimeType: 'audio/webm',
      }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 422,
    });
  });

  test('fails before writing audio when transcription is unavailable', async () => {
    mocks.enabled = false;

    await expect(
      transcribeWebchatDictation({
        audio: Buffer.from('voice-bytes'),
        mimeType: 'audio/webm',
      }),
    ).rejects.toMatchObject<Partial<GatewayRequestError>>({
      statusCode: 503,
    });
    expect(mocks.resolveModels).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  test('accepts Safari and Chromium recording formats but rejects non-audio', () => {
    expect(isSupportedDictationMimeType('audio/mp4')).toBe(true);
    expect(isSupportedDictationMimeType('audio/webm;codecs=opus')).toBe(true);
    expect(isSupportedDictationMimeType('text/plain')).toBe(false);
  });
});
