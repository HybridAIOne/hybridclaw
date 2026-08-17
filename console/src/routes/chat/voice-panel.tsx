/**
 * Voice mode status bar, shown above the composer while the mic is live.
 * Purely presentational: the session lifecycle is owned by the chat page,
 * which starts the session when voice mode opens and guarantees it ends when
 * voice mode closes, so voice can never keep running invisibly. Transcripts
 * render inline in the conversation, not here.
 *
 * NOT the transport: audio and websocket handling live in
 * `use-voice-session.ts` / `voice-audio.ts`.
 */
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';
import type { VoiceSessionStatus } from './use-voice-session';

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
  status: VoiceSessionStatus;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className={css.voicePanel} role="status" aria-live="polite">
      <div className={css.voicePanelHeader}>
        <span
          className={cx(
            css.voiceIndicator,
            props.status === 'listening' && css.voiceIndicatorListening,
            props.status === 'speaking' && css.voiceIndicatorSpeaking,
            props.status === 'thinking' && css.voiceIndicatorThinking,
            props.status === 'error' && css.voiceIndicatorError,
          )}
          aria-hidden="true"
        />
        <span className={css.voiceStatusLabel}>
          {props.error || STATUS_LABELS[props.status]}
        </span>
        <button
          type="button"
          className={css.voiceEndButton}
          onClick={props.onClose}
        >
          End voice
        </button>
      </div>
    </div>
  );
}
