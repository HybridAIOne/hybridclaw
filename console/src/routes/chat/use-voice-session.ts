/**
 * Realtime voice session hook: owns the `/api/chat/voice/stream` websocket
 * lifecycle and wires it to the `VoiceAudioPipeline` — mic chunks up, model
 * audio and barge-in clears down, plus state and transcript frames for the UI.
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

const TRANSCRIPT_LIMIT = 100;

export type VoiceSessionStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'thinking'
  | 'ended'
  | 'error';

export interface VoiceTranscriptEntry {
  id: number;
  role: 'user' | 'assistant';
  text: string;
}

export function useVoiceSession(options: {
  sessionId: string;
  agentId?: string | null;
  onAssistantTurn?: () => void;
}): {
  status: VoiceSessionStatus;
  error: string | null;
  transcripts: VoiceTranscriptEntry[];
  start: () => Promise<void>;
  stop: () => void;
} {
  const [status, setStatus] = useState<VoiceSessionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<VoiceTranscriptEntry[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const pipelineRef = useRef<VoiceAudioPipeline | null>(null);
  const transcriptIdRef = useRef(0);
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
    setTranscripts([]);
    setStatus('connecting');
    const pipeline = new VoiceAudioPipeline();
    pipelineRef.current = pipeline;
    try {
      await pipeline.start((base64Pcm) => {
        const socket = socketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'audio', payload: base64Pcm }));
        }
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
        const role: 'user' | 'assistant' =
          frame.role === 'user' ? 'user' : 'assistant';
        const text = frame.text;
        transcriptIdRef.current += 1;
        const id = transcriptIdRef.current;
        setTranscripts((current) =>
          [...current, { id, role, text }].slice(-TRANSCRIPT_LIMIT),
        );
        if (role === 'assistant') {
          optionsRef.current.onAssistantTurn?.();
        }
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

  // Ephemeral voice turns belong to one chat session: switching sessions (or
  // unmounting) ends the live session and drops the inline transcript.
  const sessionId = options.sessionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId intentionally tears down the live call on session switch.
  useEffect(() => {
    return () => {
      stop();
      setTranscripts([]);
    };
  }, [sessionId, stop]);

  return { status, error, transcripts, start, stop };
}
