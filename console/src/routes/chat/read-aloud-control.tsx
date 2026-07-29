/**
 * Read-aloud control — speaks exactly one assistant response on user request.
 *
 * Playback is globally exclusive and starts synchronously in the click handler
 * for iOS Safari; starting another response cancels the current one.
 *
 * NOT automatic TTS or realtime voice chat; it never speaks streamed content.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/button';
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';
import { getSpeechCopy } from './speech-copy';

interface ActiveReadAloud {
  id: string;
  stop: () => void;
}

let activeReadAloud: ActiveReadAloud | null = null;

function canReadAloud(): boolean {
  return Boolean(
    window.speechSynthesis &&
      typeof window.SpeechSynthesisUtterance === 'function',
  );
}

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

export function ReadAloudControl(props: { text: string }) {
  const id = useId();
  const copy = useMemo(() => getSpeechCopy(navigator.language), []);
  const supported = canReadAloud();
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const stop = () => {
    if (activeReadAloud?.id === id) activeReadAloud = null;
    utteranceRef.current = null;
    window.speechSynthesis?.cancel();
    setPlaying(false);
  };

  useEffect(() => {
    return () => {
      if (activeReadAloud?.id === id) {
        activeReadAloud = null;
        window.speechSynthesis?.cancel();
      }
    };
  }, [id]);

  const handleClick = () => {
    if (!supported) return;
    if (playing) {
      stop();
      return;
    }

    if (activeReadAloud) activeReadAloud.stop();
    else window.speechSynthesis.cancel();
    setError('');

    const utterance = new SpeechSynthesisUtterance(props.text);
    utterance.lang = navigator.language;
    utterance.onend = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      if (activeReadAloud?.id === id) activeReadAloud = null;
      setPlaying(false);
    };
    utterance.onerror = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      if (activeReadAloud?.id === id) activeReadAloud = null;
      setPlaying(false);
      setError(copy.readFailed);
    };
    utteranceRef.current = utterance;
    activeReadAloud = { id, stop };
    setPlaying(true);

    // Keep this synchronous with the pointer/keyboard activation. iOS Safari
    // rejects speech started after an awaited task because the user gesture
    // has expired.
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      utteranceRef.current = null;
      if (activeReadAloud?.id === id) activeReadAloud = null;
      setPlaying(false);
      setError(copy.readFailed);
    }
  };

  const label = !supported
    ? copy.readUnsupported
    : playing
      ? copy.stopReading
      : copy.read;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cx(css.actionButton, playing && css.actionButtonPlaying)}
        title={label}
        aria-label={label}
        aria-pressed={playing}
        disabled={!supported || !props.text}
        onClick={handleClick}
      >
        {playing ? (
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
      {playing || error ? (
        <span className={css.messageSpeechStatus} role="status">
          {playing ? copy.reading : error}
        </span>
      ) : null}
    </>
  );
}
