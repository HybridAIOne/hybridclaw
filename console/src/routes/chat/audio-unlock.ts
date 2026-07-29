/**
 * Webchat audio unlock — keeps one user-gesture-authorized playback element.
 *
 * iOS grants autoplay permission to an element, so every generated clip reuses
 * the exact element warmed synchronously by the read-aloud button.
 *
 * NOT speech generation or playback queue ownership.
 */

const SILENT_MP3 =
  'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwmHAAAAAAD/+1DEAAAGAAGn9AAAIgAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7UMQbgAAADSAAAAAAAAANIAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';

let audioElement: HTMLAudioElement | null = null;
let unlocked = false;

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function getAudioElement(): HTMLAudioElement {
  audioElement ??= new Audio();
  audioElement.preload = 'auto';
  return audioElement;
}

export function unlockAudio(): void {
  if (unlocked || !isIos()) return;
  const audio = getAudioElement();
  audio.src = SILENT_MP3;
  audio.muted = true;

  const settle = () => {
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
    unlocked = true;
  };
  const played = audio.play();
  if (played === undefined) {
    settle();
    return;
  }
  played.then(settle).catch(() => {
    audio.muted = false;
  });
}

export function playAudioClip(
  blob: Blob,
  onStart: (audio: HTMLAudioElement) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const audio = getAudioElement();
    const url = URL.createObjectURL(blob);
    const previousUrl = audio.src;
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener('ended', done);
      audio.removeEventListener('error', done);
      audio.removeEventListener('pause', onPause);
      URL.revokeObjectURL(url);
      resolve();
    };
    const onPause = () => {
      if (!audio.ended) done();
    };

    audio.addEventListener('ended', done);
    audio.addEventListener('error', done);
    audio.addEventListener('pause', onPause);
    if (previousUrl.startsWith('blob:')) {
      URL.revokeObjectURL(previousUrl);
    }
    audio.src = url;
    audio.muted = false;
    onStart(audio);
    audio.play().catch(done);
  });
}

export function resetAudioUnlockForTests(): void {
  audioElement = null;
  unlocked = false;
}
