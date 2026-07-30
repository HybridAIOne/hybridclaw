import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechPlayback, splitSpeechText } from './speech-playback';

const mocks = vi.hoisted(() => ({
  playAudioClip: vi.fn(),
  synthesizeSpeech: vi.fn(),
}));

vi.mock('../../api/chat', () => ({
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

vi.mock('./audio-unlock', () => ({
  playAudioClip: mocks.playAudioClip,
}));

describe('SpeechPlayback', () => {
  beforeEach(() => {
    mocks.playAudioClip.mockReset();
    mocks.playAudioClip.mockImplementation(
      async (_blob: Blob, onStart: (audio: HTMLAudioElement) => void) => {
        onStart({} as HTMLAudioElement);
      },
    );
    mocks.synthesizeSpeech.mockReset();
  });

  it('splits at natural pauses and plays fetched clips in order', async () => {
    const text =
      'This first sentence starts promptly. This second sentence is deliberately long enough to become the next generated speech clip.';
    const chunks = splitSpeechText(text);
    expect(chunks).toEqual([
      'This first sentence starts promptly.',
      'This second sentence is deliberately long enough to become the next generated speech clip.',
    ]);
    chunks.forEach((_chunk, index) => {
      mocks.synthesizeSpeech.mockResolvedValueOnce(
        new Blob([String(index)], { type: 'audio/mpeg' }),
      );
    });
    const onPlaying = vi.fn();
    const onSettled = vi.fn();

    const playback = new SpeechPlayback({
      token: 'test-token',
      text,
      onPlaying,
      onSettled,
    });
    playback.start();

    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(false));
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(2);
    expect(mocks.synthesizeSpeech.mock.calls[0]?.slice(0, 2)).toEqual([
      'test-token',
      chunks[0],
    ]);
    expect(mocks.synthesizeSpeech.mock.calls[1]?.slice(0, 2)).toEqual([
      'test-token',
      chunks[1],
    ]);
    expect(mocks.playAudioClip).toHaveBeenCalledTimes(2);
    expect(onPlaying).toHaveBeenCalledTimes(2);
  });

  it('aborts pending generation and settles without an error on stop', () => {
    let capturedSignal: AbortSignal | undefined;
    mocks.synthesizeSpeech.mockImplementation(
      (_token: string, _text: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<Blob>(() => undefined);
      },
    );
    const onSettled = vi.fn();
    const playback = new SpeechPlayback({
      token: 'test-token',
      text: 'A response waiting for generated speech.',
      onPlaying: vi.fn(),
      onSettled,
    });

    playback.start();
    playback.dispose();

    expect(capturedSignal?.aborted).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
