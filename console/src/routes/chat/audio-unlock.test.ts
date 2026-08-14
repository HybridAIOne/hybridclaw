import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAudioElement,
  playAudioClip,
  resetAudioUnlockForTests,
  unlockAudio,
} from './audio-unlock';

class FakeAudio extends EventTarget {
  currentTime = 0;
  ended = false;
  muted = false;
  preload = '';
  src = '';
  pause = vi.fn(() => {
    this.dispatchEvent(new Event('pause'));
  });
  play = vi.fn(async () => undefined);
}

describe('iOS audio unlock', () => {
  const audioInstances: FakeAudio[] = [];

  beforeEach(() => {
    resetAudioUnlockForTests();
    audioInstances.length = 0;
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone)',
      platform: 'iPhone',
      maxTouchPoints: 1,
    });
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor() {
          super();
          audioInstances.push(this);
        }
      },
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:generated-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('warms and reuses the same audio element for generated clips', async () => {
    unlockAudio();
    await Promise.resolve();

    const audio = getAudioElement() as unknown as FakeAudio;
    expect(audioInstances).toHaveLength(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.muted).toBe(false);

    const started = vi.fn();
    const playback = playAudioClip(
      new Blob(['mp3'], { type: 'audio/mpeg' }),
      started,
    );
    expect(audioInstances).toHaveLength(1);
    expect(audio.src).toBe('blob:generated-audio');
    expect(started).toHaveBeenCalledWith(audio);
    audio.ended = true;
    audio.dispatchEvent(new Event('ended'));
    await playback;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:generated-audio');
  });

  it('settles a clip when explicit stop pauses the shared element', async () => {
    const audio = getAudioElement() as unknown as FakeAudio;
    const playback = playAudioClip(
      new Blob(['mp3'], { type: 'audio/mpeg' }),
      vi.fn(),
    );

    audio.pause();
    await expect(playback).resolves.toBeUndefined();
  });
});
