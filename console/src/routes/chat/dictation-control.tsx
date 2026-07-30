/**
 * Dictation control — owns one explicit, cancellable microphone recording.
 *
 * Every take goes through HybridClaw's authenticated transcription route and
 * returns editable composer text; raw audio is never attached or auto-sent.
 *
 * NOT browser speech recognition or a realtime voice session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { transcribeDictation } from '../../api/chat';
import { HttpResponseError } from '../../api/client';
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';
import { DictationWave } from './dictation-wave';
import { useMediaCapabilities } from './media-capabilities';
import { getSpeechCopy } from './speech-copy';

type DictationState = 'idle' | 'requesting' | 'recording' | 'transcribing';

// Recording defaults (maintainer decision, 2026-07-29): user-selectable
// thresholds are deliberately deferred until HybridClaw has a general voice
// settings surface.
const MAX_DICTATION_DURATION_MS = 300_000;
const MIN_RECORDING_BYTES = 50;
const SPEECH_RMS_THRESHOLD = 0.1;
const TRAILING_SILENCE_MS = 3_000;
const MIME_TYPE_CANDIDATES = [
  'audio/mp4',
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
] as const;

function canRecord(): boolean {
  return (
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.MediaRecorder === 'function'
  );
}

function preferredMimeType(): string | undefined {
  if (
    typeof window.MediaRecorder !== 'function' ||
    typeof window.MediaRecorder.isTypeSupported !== 'function'
  ) {
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
  const capabilities = useMediaCapabilities(props.token);
  const browserSupported = canRecord();
  const available = browserSupported && capabilities?.dictation === true;
  const [state, setState] = useState<DictationState>('idle');
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestSequenceRef = useRef(0);
  const maxTimerRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const clearTimers = useCallback(() => {
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const stopAnalysis = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    if (mountedRef.current) setLevel(0);
  }, []);

  const resetRecording = useCallback(() => {
    clearTimers();
    stopAnalysis();
    recorderRef.current = null;
    stopTracks(streamRef.current);
    streamRef.current = null;
  }, [clearTimers, stopAnalysis]);

  const transcribe = useCallback(
    async (chunks: Blob[], mimeType: string) => {
      const recording = new Blob(chunks, {
        type: mimeType || 'audio/webm',
      });
      if (recording.size <= MIN_RECORDING_BYTES) {
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
    clearTimers();
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    setState('transcribing');
    setMessage(copy.transcribing);
    recorder.stop();
  }, [clearTimers, copy.transcribing]);

  const startLevelAnalysis = useCallback(
    (stream: MediaStream, recorder: MediaRecorder) => {
      try {
        const AudioContextConstructor =
          window.AudioContext ??
          (
            window as Window & {
              webkitAudioContext?: typeof AudioContext;
            }
          ).webkitAudioContext;
        if (!AudioContextConstructor) return;

        const audioContext = new AudioContextConstructor();
        audioContextRef.current = audioContext;
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2_048;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let speechSeen = false;

        const sample = () => {
          if (recorder.state === 'inactive') return;
          analyser.getFloatTimeDomainData(samples);
          let sumSquares = 0;
          for (const amplitude of samples) {
            sumSquares += amplitude * amplitude;
          }
          const rms = Math.sqrt(sumSquares / samples.length);
          setLevel(Math.min(1, rms * 4));

          if (rms > SPEECH_RMS_THRESHOLD) {
            speechSeen = true;
            if (silenceTimerRef.current !== null) {
              window.clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
          } else if (speechSeen && silenceTimerRef.current === null) {
            silenceTimerRef.current = window.setTimeout(
              stopRecording,
              TRAILING_SILENCE_MS,
            );
          }
          animationFrameRef.current = window.requestAnimationFrame(sample);
        };
        animationFrameRef.current = window.requestAnimationFrame(sample);
      } catch {
        stopAnalysis();
      }
    },
    [stopAnalysis, stopRecording],
  );

  const startRecording = useCallback(async () => {
    if (!available || props.disabled) return;
    const sequence = ++requestSequenceRef.current;
    setState('requesting');
    setMessage(copy.requestingMic);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: { ideal: true },
          echoCancellation: { ideal: true },
          autoGainControl: { ideal: true },
        },
      });
      if (!mountedRef.current || sequence !== requestSequenceRef.current) {
        stopTracks(stream);
        return;
      }

      const mimeType = preferredMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      } catch {
        recorder = new MediaRecorder(stream);
      }

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

      recorder.start(1_000);
      setState('recording');
      setMessage(copy.listening);
      startLevelAnalysis(stream, recorder);
      maxTimerRef.current = window.setTimeout(
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
    startLevelAnalysis,
    stopRecording,
    available,
    transcribe,
  ]);

  const releaseRecording = useCallback(() => {
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
  }, [resetRecording]);

  const cancel = useCallback(() => {
    releaseRecording();
    setState('idle');
    setMessage('');
  }, [releaseRecording]);

  useEffect(() => {
    if (props.disabled && state !== 'idle') cancel();
  }, [cancel, props.disabled, state]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      releaseRecording();
    };
  }, [releaseRecording]);

  const handleClick = () => {
    if (state === 'idle') {
      void startRecording();
    } else if (state === 'recording') {
      stopRecording();
    } else {
      cancel();
    }
  };

  const label = !browserSupported
    ? copy.micUnsupported
    : capabilities?.dictation === false
      ? copy.micUnavailable
      : state === 'recording'
        ? copy.stopDictation
        : state === 'requesting' || state === 'transcribing'
          ? copy.cancelDictation
          : copy.dictate;

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
        disabled={props.disabled || !available}
        title={label}
        data-dictation-state={state}
      >
        {state === 'recording' ? (
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
        )}
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
          {state === 'recording' ? <DictationWave level={level} /> : null}
          <span>{message}</span>
        </span>
      ) : null}
    </>
  );
}
