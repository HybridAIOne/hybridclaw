/**
 * Dictation control — owns one explicit, cancellable microphone session.
 *
 * Browser speech recognition handles the common Chrome/Safari path; browsers
 * without it record into HybridClaw's authenticated transcription route.
 * Either path returns editable composer text and never sends it automatically.
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

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
}

interface BrowserSpeechRecognitionResult {
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionResult;
}

interface BrowserSpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: BrowserSpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: ((event: Event) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onstart: ((event: Event) => void) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

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

function getBrowserSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  const speechWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return (
    speechWindow.SpeechRecognition ??
    speechWindow.webkitSpeechRecognition ??
    null
  );
}

function canRecordForServerTranscription(): boolean {
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

function readRecognitionTranscript(
  results: BrowserSpeechRecognitionResultList,
): string {
  const segments: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const transcript = results[index]?.[0]?.transcript.trim();
    if (transcript) segments.push(transcript);
  }
  return segments.join(' ').trim();
}

export function DictationControl(props: {
  disabled: boolean;
  onTranscript: (text: string) => void;
  token: string;
}) {
  const copy = useMemo(() => getSpeechCopy(navigator.language), []);
  const recognitionConstructor = getBrowserSpeechRecognitionConstructor();
  const supported =
    recognitionConstructor !== null || canRecordForServerTranscription();
  const [state, setState] = useState<DictationState>('idle');
  const [message, setMessage] = useState('');
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const recognitionTranscriptRef = useRef('');
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

  const resetRecognition = useCallback(() => {
    clearTimeoutRef();
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
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

  const startBrowserRecognition = useCallback(() => {
    if (!recognitionConstructor || props.disabled) return;
    const sequence = ++requestSequenceRef.current;
    setState('requesting');
    setMessage(copy.requestingMic);

    const recognition = new recognitionConstructor();
    let errorMessage = '';
    recognitionRef.current = recognition;
    recognitionTranscriptRef.current = '';
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (
        !mountedRef.current ||
        sequence !== requestSequenceRef.current ||
        recognitionRef.current !== recognition
      ) {
        recognition.abort();
        return;
      }
      setState('recording');
      setMessage(copy.listening);
    };
    recognition.onresult = (event) => {
      recognitionTranscriptRef.current = readRecognitionTranscript(
        event.results,
      );
    };
    recognition.onerror = (event) => {
      if (event.error === 'aborted') return;
      if (
        event.error === 'not-allowed' ||
        event.error === 'service-not-allowed'
      ) {
        errorMessage = copy.micDenied;
        return;
      }
      errorMessage =
        event.error === 'no-speech' ? copy.noSpeech : copy.micFailed;
    };
    recognition.onend = () => {
      const transcript = recognitionTranscriptRef.current.trim();
      resetRecognition();
      if (!mountedRef.current || sequence !== requestSequenceRef.current) {
        return;
      }
      setState('idle');
      if (errorMessage) {
        setMessage(errorMessage);
        return;
      }
      if (!transcript) {
        setMessage(copy.noSpeech);
        return;
      }
      setMessage('');
      props.onTranscript(transcript);
    };

    try {
      recognition.start();
      timeoutRef.current = window.setTimeout(() => {
        if (recognitionRef.current !== recognition) return;
        setState('transcribing');
        setMessage(copy.transcribing);
        recognition.stop();
      }, MAX_DICTATION_DURATION_MS);
    } catch (error) {
      resetRecognition();
      if (!mountedRef.current || sequence !== requestSequenceRef.current) {
        return;
      }
      setState('idle');
      setMessage(isPermissionDenied(error) ? copy.micDenied : copy.micFailed);
    }
  }, [
    copy,
    props.disabled,
    props.onTranscript,
    recognitionConstructor,
    resetRecognition,
  ]);

  const startServerRecording = useCallback(async () => {
    if (!canRecordForServerTranscription() || props.disabled) return;
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
  }, [copy, props.disabled, resetRecording, stopRecording, transcribe]);

  const stopDictation = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      clearTimeoutRef();
      setState('transcribing');
      setMessage(copy.transcribing);
      recognition.stop();
      return;
    }
    stopRecording();
  }, [clearTimeoutRef, copy.transcribing, stopRecording]);

  const startDictation = useCallback(() => {
    if (recognitionConstructor) {
      startBrowserRecognition();
      return;
    }
    void startServerRecording();
  }, [recognitionConstructor, startBrowserRecognition, startServerRecording]);

  const cancel = useCallback(() => {
    requestSequenceRef.current += 1;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    const recognition = recognitionRef.current;
    resetRecognition();
    recognitionTranscriptRef.current = '';
    recognition?.abort();
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
  }, [resetRecognition, resetRecording]);

  useEffect(() => {
    if (props.disabled && state !== 'idle') cancel();
  }, [cancel, props.disabled, state]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      transcriptionAbortRef.current?.abort();
      const recognition = recognitionRef.current;
      resetRecognition();
      recognition?.abort();
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
  }, [resetRecognition, resetRecording]);

  const handleClick = () => {
    if (state === 'idle') {
      startDictation();
      return;
    }
    if (state === 'recording') {
      stopDictation();
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
