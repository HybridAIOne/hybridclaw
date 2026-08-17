/**
 * Realtime voice session hook: owns the `/api/chat/voice/stream` websocket
 * lifecycle and wires it to the `VoiceAudioPipeline` — mic chunks up, model
 * audio and barge-in clears down, plus status for the UI. Transcript frames
 * only signal that a turn was persisted; the chat page refetches history to
 * render it.
 *
 * Guarantees teardown is idempotent (stop, server `ended`, socket close,
 * session switch, and unmount all funnel through one cleanup path) so the mic
 * never stays hot after voice mode closes.
 *
 * NOT the UI: the status bar lives in `voice-panel.tsx` and transcripts
 * render inline in the chat page's conversation view.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { chatVoiceSocketUrl } from '../../api/client';
import { VoiceAudioPipeline } from './voice-audio';

// ~20s of mic audio at the pipeline's ~171ms chunk cadence.
const PENDING_AUDIO_LIMIT = 120;

export type VoiceSessionStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'thinking'
  | 'ended'
  | 'error';

export function useVoiceSession(options: {
  sessionId: string;
  agentId?: string | null;
  /** Fired per spoken turn; the gateway has already persisted it to history. */
  onTranscript?: (role: 'user' | 'assistant') => void;
}): {
  status: VoiceSessionStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
} {
  const [status, setStatus] = useState<VoiceSessionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pipelineRef = useRef<VoiceAudioPipeline | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stop = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'stop' }));
    }
    socket?.close();
    pipelineRef.current?.stop();
    pipelineRef.current = null;
    setStatus((current) =>
      current === 'error' || current === 'idle' ? current : 'ended',
    );
  }, []);

  const start = useCallback(async () => {
    if (socketRef.current) return;
    setError(null);
    setStatus('connecting');
    const pipeline = new VoiceAudioPipeline();
    pipelineRef.current = pipeline;
    // The mic captures before the gateway session is up; buffer those chunks
    // and flush on `ready` so speech from the first seconds is not lost.
    const pendingAudio: string[] = [];
    let sessionReady = false;
    const sendAudio = (socket: WebSocket, base64Pcm: string) => {
      socket.send(JSON.stringify({ type: 'audio', payload: base64Pcm }));
    };
    try {
      await pipeline.start((base64Pcm) => {
        const socket = socketRef.current;
        if (sessionReady && socket && socket.readyState === WebSocket.OPEN) {
          sendAudio(socket, base64Pcm);
          return;
        }
        pendingAudio.push(base64Pcm);
        if (pendingAudio.length > PENDING_AUDIO_LIMIT) pendingAudio.shift();
      });
    } catch {
      pipelineRef.current = null;
      pipeline.stop();
      setError('Microphone access was denied.');
      setStatus('error');
      return;
    }
    const socket = new WebSocket(chatVoiceSocketUrl());
    socketRef.current = socket;
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'start',
          sessionId: optionsRef.current.sessionId,
          agentId: optionsRef.current.agentId || undefined,
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      let frame: { type?: string } & Record<string, unknown>;
      try {
        frame = JSON.parse(String(event.data)) as typeof frame;
      } catch {
        return;
      }
      if (frame.type === 'ready') {
        sessionReady = true;
        if (socket.readyState === WebSocket.OPEN) {
          for (const chunk of pendingAudio) sendAudio(socket, chunk);
        }
        pendingAudio.length = 0;
        setStatus('listening');
        return;
      }
      if (frame.type === 'audio' && typeof frame.payload === 'string') {
        pipelineRef.current?.playAudio(frame.payload);
        return;
      }
      if (frame.type === 'clear') {
        pipelineRef.current?.clearPlayback();
        return;
      }
      if (frame.type === 'state' && typeof frame.state === 'string') {
        const state = frame.state;
        if (
          state === 'listening' ||
          state === 'speaking' ||
          state === 'thinking'
        ) {
          setStatus(state);
        }
        return;
      }
      if (
        frame.type === 'transcript' &&
        typeof frame.text === 'string' &&
        (frame.role === 'user' || frame.role === 'assistant')
      ) {
        optionsRef.current.onTranscript?.(
          frame.role === 'user' ? 'user' : 'assistant',
        );
        return;
      }
      if (frame.type === 'error' && typeof frame.message === 'string') {
        setError(frame.message);
        return;
      }
      if (frame.type === 'ended') {
        stop();
      }
    });
    socket.addEventListener('close', () => {
      if (socketRef.current === socket) {
        stop();
      }
    });
    socket.addEventListener('error', () => {
      setError('Voice connection failed.');
      setStatus('error');
    });
  }, [stop]);

  // A live voice call belongs to one chat session: switching sessions (or
  // unmounting) ends it.
  const sessionId = options.sessionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId intentionally tears down the live call on session switch.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [sessionId, stop]);

  return { status, error, start, stop };
}
