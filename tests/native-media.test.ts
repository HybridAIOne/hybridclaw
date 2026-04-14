import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

describe('native media injection', () => {
  test('injects native audio parts for vllm when no transcript is present', async () => {
    const tempDir = makeTempDir('hybridclaw-wa-');
    const audioPath = path.join(tempDir, 'voice-note.ogg');
    fs.writeFileSync(audioPath, 'voice-bytes', 'utf-8');

    const { injectNativeAudioContent } = await import(
      '../container/src/native-media.ts'
    );

    const messages = [
      { role: 'user' as const, content: 'please summarize this' },
    ];
    const prepared = await injectNativeAudioContent({
      messages,
      provider: 'vllm',
      media: [
        {
          path: audioPath,
          url: `file://${audioPath}`,
          originalUrl: `file://${audioPath}`,
          mimeType: 'audio/ogg; codecs=opus',
          sizeBytes: 11,
          filename: 'voice-note.ogg',
        },
      ],
    });

    expect(prepared).not.toBe(messages);
    const content = prepared[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const textPart = Array.isArray(content)
      ? content.find((part) => part.type === 'text')
      : null;
    const audioPart = Array.isArray(content)
      ? content.find((part) => part.type === 'audio_url')
      : null;

    expect(textPart).toMatchObject({
      type: 'text',
      text: expect.stringContaining('[NativeAudio]'),
    });
    expect(textPart).toMatchObject({
      type: 'text',
      text: expect.stringContaining('please summarize this'),
    });
    expect(audioPart).toMatchObject({
      type: 'audio_url',
      audio_url: {
        url: expect.stringMatching(/^data:audio\/ogg;base64,/),
      },
    });
  });

  test('skips native audio injection when a transcript was already prepended', async () => {
    const tempDir = makeTempDir('hybridclaw-wa-');
    const audioPath = path.join(tempDir, 'voice-note.ogg');
    fs.writeFileSync(audioPath, 'voice-bytes', 'utf-8');

    const { injectNativeAudioContent } = await import(
      '../container/src/native-media.ts'
    );

    const messages = [
      {
        role: 'user' as const,
        content: 'hello',
      },
    ];
    const prepared = await injectNativeAudioContent({
      messages,
      provider: 'vllm',
      audioTranscriptsPrepended: true,
      media: [
        {
          path: audioPath,
          url: `file://${audioPath}`,
          originalUrl: `file://${audioPath}`,
          mimeType: 'audio/ogg; codecs=opus',
          sizeBytes: 11,
          filename: 'voice-note.ogg',
        },
      ],
    });

    expect(prepared).toBe(messages);
  });

  test('retries when the provider rejects native audio parts', async () => {
    const { shouldRetryWithoutNativeMedia } = await import(
      '../container/src/native-media.ts'
    );

    expect(
      shouldRetryWithoutNativeMedia('Unsupported content part: audio_url'),
    ).toBe(true);
    expect(
      shouldRetryWithoutNativeMedia('Model does not support audio input'),
    ).toBe(true);
    expect(shouldRetryWithoutNativeMedia('context overflow')).toBe(false);
  });
});
