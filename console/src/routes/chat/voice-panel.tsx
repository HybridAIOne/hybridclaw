/**
 * Voice mode capsule: a compact live-call chip floating above the composer
 * while the mic is live. Its animated waveform mirrors the composer's voice
 * button glyph and encodes state — breathing while listening, dancing while
 * the model speaks, sweeping while it consults the agent.
 *
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

const STATUS_CLASSES: Partial<Record<VoiceSessionStatus, string>> = {
  listening: css.voiceCapsuleListening,
  speaking: css.voiceCapsuleSpeaking,
  thinking: css.voiceCapsuleThinking,
  ended: css.voiceCapsuleEnded,
  error: css.voiceCapsuleError,
};

const WAVE_BARS = [0, 1, 2, 3, 4];

export function VoicePanel(props: {
  status: VoiceSessionStatus;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div
      className={cx(css.voiceCapsule, STATUS_CLASSES[props.status])}
      role="status"
      aria-live="polite"
    >
      <span className={css.voiceWave} aria-hidden="true">
        {WAVE_BARS.map((bar) => (
          <span key={bar} className={css.voiceWaveBar} />
        ))}
      </span>
      <span className={css.voiceStatusLabel}>
        {props.error || STATUS_LABELS[props.status]}
      </span>
      <button
        type="button"
        className={css.voiceEndButton}
        onClick={props.onClose}
        aria-label="End voice mode"
      >
        End
      </button>
    </div>
  );
}
