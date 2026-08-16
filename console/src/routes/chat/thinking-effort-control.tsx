/**
 * Composer thinking control — selects one explicit effort for submitted turns.
 *
 * Model default remains distinct from Off; the caller supplies the exact
 * provider-supported tiers and this component never invents extra choices.
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
  supportedEfforts: ReasoningEffort[];
  disabled?: boolean;
  onChange: (value?: ReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const efforts = REASONING_EFFORTS.filter((effort) =>
    props.supportedEfforts.includes(effort),
  );
  const selectedIndex = props.value ? efforts.indexOf(props.value) : -1;
  const defaultIndex = Math.max(0, efforts.indexOf('medium'));
  const sliderValue = selectedIndex >= 0 ? selectedIndex : defaultIndex;
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
          max={efforts.length - 1}
          step={1}
          value={sliderValue}
          aria-label="Thinking effort level"
          aria-valuetext={valueLabel}
          onChange={(event) => {
            const effort = efforts[Number(event.currentTarget.value)];
            if (effort) props.onChange(effort);
          }}
        />
        <div
          className={css.thinkingEffortTicks}
          style={{
            gridTemplateColumns: `repeat(${efforts.length}, minmax(0, 1fr))`,
          }}
          aria-hidden="true"
        >
          {efforts.map((effort) => (
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
