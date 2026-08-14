/**
 * Dictation waveform — maps the recorder's live input level to a calm pulse.
 *
 * Bars animate only with transform so recording never triggers layout work;
 * the recorder, not this visual, decides when silence ends a take.
 *
 * NOT an audio analyser or recorded-waveform editor.
 */

import type { CSSProperties } from 'react';
import css from './chat-page.module.css';

const BARS = [
  ['far-left', 0.35],
  ['outer-left', 0.55],
  ['mid-left', 0.8],
  ['inner-left', 1],
  ['center-left', 0.72],
  ['center-right', 0.45],
  ['inner-right', 0.64],
  ['mid-right', 0.9],
  ['outer-right', 0.6],
  ['far-right', 0.4],
] as const;

export function DictationWave(props: { level: number }) {
  return (
    <span className={css.dictationWave} aria-hidden="true">
      {BARS.map(([id, factor]) => (
        <span
          key={id}
          style={
            {
              '--dictation-scale': Math.max(
                0.18,
                Math.min(1, props.level * factor),
              ),
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}
