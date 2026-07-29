/**
 * Dictation control — owns one explicit, cancellable microphone recording.
 *
 * Recordings are sent only to HybridClaw's authenticated transcription route,
 * then the returned text is handed to the composer for review and editing.
 *
 * NOT a send action or realtime voice session; it never submits chat content.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { transcribeDictation } from '../../api/chat';
import { HttpResponseError } from '../../api/client';
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';
import { getSpeechCopy } from './speech-copy';

type DictationState = 'idle' | 'requesting' | 'recording' | 'transcribing';

// 120s (Codex implementation call, 2026-07-29): enough for composer
// dictation while bounding forgotten recordings; configurable durations and
// realtime voice activity detection are deliberately deferred.
const MAX_DICTATION_DURATION_MS = 120_000;
const MIME_TYPE_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

function canRecordAudio(): boolean {
  return (
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.MediaRecorder === 'function'
  );
}

function preferredMimeType(): string | undefined {
  if (typeof window.MediaRecorder !== 'function') return undefined;
  if (typeof window.MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  return MIME_TYPE_CANDIDATES.find((candidate) =>
    window.MediaRecorder.isTypeSupported(candidate),
  );
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function isPermissionDenied(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  );
}

export function DictationControl(props: {
  disabled: boolean;
  onTranscript: (text: string) => void;
  token: string;
}) {
  const copy = useMemo(() => getSpeechCopy(navigator.language), []);
  const supported = canRecordAudio();
  const [state, setState] = useState<DictationState>('idle');
  const [message, setMessage] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestSequenceRef = useRef(0);
  const timeoutRef = useRef<number | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const clearTimeoutRef = useCallback(() => {
    if (timeoutRef.current === null) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const resetRecording = useCallback(() => {
    clearTimeoutRef();
    recorderRef.current = null;
    stopTracks(streamRef.current);
    streamRef.current = null;
  }, [clearTimeoutRef]);

  const transcribe = useCallback(
    async (chunks: Blob[], mimeType: string) => {
      const recording = new Blob(chunks, {
        type: mimeType || 'audio/webm',
      });
      if (recording.size === 0) {
        if (mountedRef.current) {
          setState('idle');
          setMessage(copy.noSpeech);
        }
        return;
      }

      const abortController = new AbortController();
      transcriptionAbortRef.current = abortController;
      setState('transcribing');
      setMessage(copy.transcribing);
      try {
        const result = await transcribeDictation(
          props.token,
          recording,
          abortController.signal,
        );
        if (!mountedRef.current || abortController.signal.aborted) return;
        const text = result.text.trim();
        setState('idle');
        if (!text) {
          setMessage(copy.noSpeech);
          return;
        }
        setMessage('');
        props.onTranscript(text);
      } catch (error) {
        if (!mountedRef.current || abortController.signal.aborted) return;
        setState('idle');
        setMessage(
          error instanceof HttpResponseError && error.status === 422
            ? copy.noSpeech
            : copy.micFailed,
        );
      } finally {
        if (transcriptionAbortRef.current === abortController) {
          transcriptionAbortRef.current = null;
        }
      }
    },
    [copy, props.onTranscript, props.token],
  );

  const stopRecording = useCallback(() => {
    clearTimeoutRef();
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
  }, [clearTimeoutRef]);

  const startRecording = useCallback(async () => {
    if (!supported || props.disabled) return;
    const sequence = ++requestSequenceRef.current;
    setState('requesting');
    setMessage(copy.requestingMic);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || sequence !== requestSequenceRef.current) {
        stopTracks(stream);
        return;
      }

      const mimeType = preferredMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        resetRecording();
        if (!mountedRef.current) return;
        setState('idle');
        setMessage(copy.micFailed);
      };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        const recordedMimeType = recorder.mimeType || mimeType || 'audio/webm';
        resetRecording();
        if (!mountedRef.current) return;
        void transcribe(chunks, recordedMimeType);
      };

      recorder.start();
      setState('recording');
      setMessage(copy.listening);
      timeoutRef.current = window.setTimeout(
        stopRecording,
        MAX_DICTATION_DURATION_MS,
      );
    } catch (error) {
      resetRecording();
      if (!mountedRef.current || sequence !== requestSequenceRef.current) {
        return;
      }
      setState('idle');
      setMessage(isPermissionDenied(error) ? copy.micDenied : copy.micFailed);
    }
  }, [
    copy,
    props.disabled,
    resetRecording,
    stopRecording,
    supported,
    transcribe,
  ]);

  const cancel = useCallback(() => {
    requestSequenceRef.current += 1;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      recorder.stop();
    }
    resetRecording();
    chunksRef.current = [];
    setState('idle');
    setMessage('');
  }, [resetRecording]);

  useEffect(() => {
    if (props.disabled && state !== 'idle') cancel();
  }, [cancel, props.disabled, state]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      transcriptionAbortRef.current?.abort();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
      resetRecording();
    };
  }, [resetRecording]);

  const handleClick = () => {
    if (state === 'idle') {
      void startRecording();
      return;
    }
    if (state === 'recording') {
      stopRecording();
      return;
    }
    cancel();
  };

  const label =
    state === 'recording'
      ? copy.stopDictation
      : state === 'requesting' || state === 'transcribing'
        ? copy.cancelDictation
        : supported
          ? copy.dictate
          : copy.micUnsupported;

  return (
    <>
      <button
        type="button"
        className={cx(
          css.dictationButton,
          state === 'recording' && css.dictationButtonRecording,
        )}
        onClick={handleClick}
        aria-label={label}
        aria-pressed={state === 'recording'}
        disabled={props.disabled || !supported}
        title={label}
      >
        <svg
          viewBox="0 0 24 24"
          width="17"
          height="17"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <path d="M12 17v5" />
          <path d="M8 22h8" />
        </svg>
      </button>
      {message ? (
        <span
          className={cx(
            css.speechStatus,
            state === 'recording' && css.speechStatusActive,
          )}
          role="status"
          aria-live="polite"
        >
          {message}
        </span>
      ) : null}
    </>
  );
}
