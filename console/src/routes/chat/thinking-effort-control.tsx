/**
 * Composer thinking control — selects one explicit effort for submitted turns.
 *
 * Model default remains distinct from Off; this component does not persist
 * preferences or decide whether a provider supports a particular level.
 */

import { useState } from 'react';
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '../../../../container/shared/reasoning-effort.js';
import { Lightbulb } from '../../components/icons';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '../../components/popover';
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

export function ThinkingEffortControl(props: {
  value?: ReasoningEffort;
  disabled?: boolean;
  onChange: (value?: ReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const sliderValue = props.value
    ? REASONING_EFFORTS.indexOf(props.value)
    : REASONING_EFFORTS.indexOf('medium');
  const valueLabel = props.value ? EFFORT_LABELS[props.value] : 'Model default';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor>
        <button
          type="button"
          className={cx(css.composerPill, css.thinkingEffortTrigger)}
          disabled={props.disabled}
          aria-label={`Thinking effort: ${valueLabel}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Lightbulb width="16" height="16" aria-hidden="true" />
          <span className={css.thinkingEffortTriggerText}>{valueLabel}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        className={css.thinkingEffortPopover}
        side="top"
        align="start"
        sideOffset={8}
        role="dialog"
        aria-label="Thinking effort"
        focusOnOpen={(content) =>
          content
            .querySelector<HTMLInputElement>('input[type="range"]')
            ?.focus()
        }
      >
        <div className={css.thinkingEffortHeading}>Thinking effort</div>
        <div className={css.thinkingEffortValue}>{valueLabel}</div>
        <input
          className={cx(
            css.thinkingEffortRange,
            !props.value && css.thinkingEffortRangeDefault,
          )}
          type="range"
          min={0}
          max={REASONING_EFFORTS.length - 1}
          step={1}
          value={sliderValue}
          aria-label="Thinking effort level"
          aria-valuetext={valueLabel}
          onChange={(event) => {
            const effort = REASONING_EFFORTS[Number(event.currentTarget.value)];
            if (effort) props.onChange(effort);
          }}
        />
        <div className={css.thinkingEffortTicks} aria-hidden="true">
          {REASONING_EFFORTS.map((effort) => (
            <span key={effort}>{EFFORT_LABELS[effort]}</span>
          ))}
        </div>
        <button
          type="button"
          className={css.thinkingEffortDefault}
          aria-pressed={!props.value}
          onClick={() => props.onChange(undefined)}
        >
          Use model default
        </button>
      </PopoverContent>
    </Popover>
  );
}
