/**
 * Per-response speech playback — fetches sentence-ish audio clips in parallel.
 *
 * Clips play in source order through the shared iOS-unlocked audio element and
 * disposal aborts pending requests plus the active clip immediately.
 *
 * NOT automatic narration or streaming assistant-token playback.
 */

import { synthesizeSpeech } from '../../api/chat';
import { playAudioClip } from './audio-unlock';

const FIRST_CHUNK_CHARS = 30;
const NEXT_CHUNK_CHARS = 100;
const BREAKPOINT_LOOKAHEAD = 50;

function findBreakpoint(
  pending: string,
  minimum: number,
  isFinal: boolean,
): number {
  if (isFinal) return pending.length;
  if (pending.length < minimum) return -1;
  const window = pending.slice(0, minimum + BREAKPOINT_LOOKAHEAD);
  const sentence = /[.!?](\s|$)/.exec(window);
  if (sentence && sentence.index > 0) return sentence.index + 1;
  const space = window.lastIndexOf(' ');
  return space > 0 ? space : minimum;
}

export function splitSpeechText(text: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const pending = text.slice(cursor).trimStart();
    cursor += text.slice(cursor).length - pending.length;
    if (!pending) break;
    const minimum = chunks.length === 0 ? FIRST_CHUNK_CHARS : NEXT_CHUNK_CHARS;
    const cut = findBreakpoint(
      pending,
      minimum,
      pending.length <= minimum + BREAKPOINT_LOOKAHEAD,
    );
    if (cut <= 0) break;
    const chunk = pending.slice(0, cut).trim();
    cursor += cut;
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

export class SpeechPlayback {
  readonly #abortController = new AbortController();
  readonly #clips: Promise<Blob>[];
  readonly #onPlaying: () => void;
  readonly #onSettled: (failed: boolean) => void;
  #audio: HTMLAudioElement | null = null;
  #disposed = false;

  constructor(params: {
    token: string;
    text: string;
    onPlaying: () => void;
    onSettled: (failed: boolean) => void;
  }) {
    this.#onPlaying = params.onPlaying;
    this.#onSettled = params.onSettled;
    this.#clips = splitSpeechText(params.text).map((chunk) => {
      const request = synthesizeSpeech(
        params.token,
        chunk,
        this.#abortController.signal,
      );
      request.catch(() => undefined);
      return request;
    });
  }

  start(): void {
    void this.#play();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortController.abort();
    this.#clips.length = 0;
    this.#audio?.pause();
    this.#audio = null;
  }

  async #play(): Promise<void> {
    let failed = false;
    try {
      while (this.#clips.length > 0 && !this.#disposed) {
        const next = this.#clips.shift();
        if (!next) break;
        const clip = await next;
        if (this.#disposed) return;
        await playAudioClip(clip, (audio) => {
          this.#audio = audio;
          this.#onPlaying();
        });
        this.#audio = null;
      }
    } catch {
      failed = !this.#abortController.signal.aborted;
    } finally {
      if (!this.#disposed) this.#onSettled(failed);
    }
  }
}
