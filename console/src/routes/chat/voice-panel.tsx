/**
 * Voice mode panel: the visible surface of a realtime voice session, shown
 * above the composer while the mic is live. Auto-starts its session on mount
 * and guarantees the session ends when the panel unmounts or the user closes
 * it, so voice can never keep running invisibly.
 *
 * NOT the transport: audio and websocket handling live in
 * `use-voice-session.ts` / `voice-audio.ts`.
 */
import { useEffect } from 'react';
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';
import { useVoiceSession, type VoiceSessionStatus } from './use-voice-session';

const STATUS_LABELS: Record<VoiceSessionStatus, string> = {
  idle: 'Starting…',
  connecting: 'Connecting…',
  listening: 'Listening',
  speaking: 'Speaking',
  thinking: 'Checking with the assistant…',
  ended: 'Voice session ended',
  error: 'Voice error',
};

export function VoicePanel(props: {
  sessionId: string;
  agentId?: string | null;
  onAssistantTurn?: () => void;
  onClose: () => void;
}) {
  const session = useVoiceSession({
    sessionId: props.sessionId,
    agentId: props.agentId,
    onAssistantTurn: props.onAssistantTurn,
  });
  const { start } = session;

  useEffect(() => {
    void start();
  }, [start]);

  return (
    <div className={css.voicePanel} role="status" aria-live="polite">
      <div className={css.voicePanelHeader}>
        <span
          className={cx(
            css.voiceIndicator,
            session.status === 'listening' && css.voiceIndicatorListening,
            session.status === 'speaking' && css.voiceIndicatorSpeaking,
            session.status === 'thinking' && css.voiceIndicatorThinking,
            session.status === 'error' && css.voiceIndicatorError,
          )}
          aria-hidden="true"
        />
        <span className={css.voiceStatusLabel}>
          {session.error || STATUS_LABELS[session.status]}
        </span>
        <button
          type="button"
          className={css.voiceEndButton}
          onClick={() => {
            session.stop();
            props.onClose();
          }}
        >
          End voice
        </button>
      </div>
      {session.transcripts.length > 0 ? (
        <div className={css.voiceTranscripts}>
          {session.transcripts.map((entry) => (
            <div key={entry.id} className={css.voiceTranscriptLine}>
              <span className={css.voiceTranscriptRole}>
                {entry.role === 'user' ? 'You' : 'HybridClaw'}
              </span>
              <span>{entry.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
