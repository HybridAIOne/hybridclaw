/**
 * Read-aloud control — owns explicit playback for one completed response.
 *
 * Starting one response stops any other, unlocks audio in the click gesture,
 * and delegates authenticated speech generation to the gateway.
 *
 * NOT automatic narration or browser speech synthesis.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/button';
import { cx } from '../../lib/cx';
import { unlockAudio } from './audio-unlock';
import css from './chat-page.module.css';
import { useMediaCapabilities } from './media-capabilities';
import { getSpeechCopy } from './speech-copy';
import { SpeechPlayback } from './speech-playback';

interface ActiveReadAloud {
  id: string;
  stop: () => void;
}

let activeReadAloud: ActiveReadAloud | null = null;

export function textFromRenderedMarkdown(html: string): string {
  const root = document.createElement('div');
  root.innerHTML = html;
  for (const element of root.querySelectorAll(
    'blockquote, br, div, h1, h2, h3, h4, h5, h6, li, p, pre, section',
  )) {
    element.append(' ');
  }
  return (root.textContent || '').replace(/\s+/g, ' ').trim();
}

export function ReadAloudControl(props: { text: string; token: string }) {
  const id = useId();
  const copy = useMemo(() => getSpeechCopy(document.documentElement.lang), []);
  const capabilities = useMediaCapabilities(props.token);
  const browserSupported = typeof window.Audio === 'function';
  const available = capabilities?.readAloud === true;
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [error, setError] = useState('');
  const playbackRef = useRef<SpeechPlayback | null>(null);

  const stop = () => {
    playbackRef.current?.dispose();
    playbackRef.current = null;
    if (activeReadAloud?.id === id) activeReadAloud = null;
    setStatus('idle');
  };

  useEffect(() => {
    return () => {
      playbackRef.current?.dispose();
      playbackRef.current = null;
      if (activeReadAloud?.id === id) activeReadAloud = null;
    };
  }, [id]);

  const handleClick = () => {
    if (!available || !browserSupported) return;
    if (status !== 'idle') {
      stop();
      return;
    }

    // This must remain synchronous with the click: iOS expires the playback
    // gesture before the authenticated speech request resolves.
    unlockAudio();
    activeReadAloud?.stop();
    setError('');
    setStatus('loading');

    let playback: SpeechPlayback | null = null;
    playback = new SpeechPlayback({
      token: props.token,
      text: props.text,
      onPlaying: () => {
        if (playback && playbackRef.current === playback) setStatus('playing');
      },
      onSettled: (failed) => {
        if (!playback || playbackRef.current !== playback) return;
        playbackRef.current = null;
        if (activeReadAloud?.id === id) activeReadAloud = null;
        setStatus('idle');
        if (failed) setError(copy.readFailed);
      },
    });
    playbackRef.current = playback;
    activeReadAloud = { id, stop };
    playback.start();
  };

  const active = status !== 'idle';
  const label = !browserSupported
    ? copy.readUnsupported
    : capabilities?.readAloud === false
      ? copy.readUnavailable
      : active
        ? copy.stopReading
        : copy.read;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cx(css.actionButton, active && css.actionButtonPlaying)}
        title={label}
        aria-label={label}
        aria-pressed={active}
        disabled={!available || !browserSupported || !props.text}
        onClick={handleClick}
      >
        {active ? (
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="currentColor"
            aria-hidden="true"
          >
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M11 5 6 9H3v6h3l5 4z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18 6a8.5 8.5 0 0 1 0 12" />
          </svg>
        )}
      </Button>
      {active || error ? (
        <span className={css.messageSpeechStatus} role="status">
          {status === 'loading'
            ? copy.preparingSpeech
            : status === 'playing'
              ? copy.reading
              : error}
        </span>
      ) : null}
    </>
  );
}
