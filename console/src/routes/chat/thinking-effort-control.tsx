/**
 * Thinking effort control — exposes only levels advertised by the selected model.
 * It does not infer provider capabilities or persist a gateway default.
 */
import { useMemo, useState } from 'react';
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '../../../../container/shared/reasoning-effort.js';
import { ChevronDown, Lightbulb } from '../../components/icons';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '../../components/popover';
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';

const LABELS: Record<ReasoningEffort, string> = {
  none: 'Off',
  low: 'Low',
  medium: 'Medium',
  xhigh: 'XHigh',
};

export function ThinkingEffortControl(props: {
  supportedEfforts: ReasoningEffort[];
  value?: ReasoningEffort;
  disabled?: boolean;
  onChange: (value: ReasoningEffort | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const choices = useMemo(
    () => [
      undefined,
      ...REASONING_EFFORTS.filter((effort) =>
        props.supportedEfforts.includes(effort),
      ),
    ],
    [props.supportedEfforts],
  );
  const index = Math.max(0, choices.indexOf(props.value));
  const label = props.value ? LABELS[props.value] : 'Model default';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor>
        <button
          type="button"
          className={cx(css.composerPill, css.thinkingEffortTrigger)}
          disabled={props.disabled}
          aria-label={`Thinking effort: ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Lightbulb width={15} height={15} aria-hidden="true" />
          <span>{label}</span>
          <ChevronDown
            width={14}
            height={14}
            className={css.composerPillChevron}
            aria-hidden="true"
          />
        </button>
      </PopoverAnchor>
      <PopoverContent
        className={css.thinkingEffortPopover}
        align="start"
        side="top"
        focusOnOpen="none"
        role="dialog"
        aria-label="Thinking effort"
      >
        <div className={css.thinkingEffortHeader}>Thinking effort</div>
        <input
          className={css.thinkingEffortSlider}
          type="range"
          min={0}
          max={choices.length - 1}
          step={1}
          value={index}
          aria-label="Thinking effort"
          aria-valuetext={label}
          onChange={(event) =>
            props.onChange(choices[Number(event.target.value)])
          }
        />
        <div className={css.thinkingEffortLabels} aria-hidden="true">
          {choices.map((effort) => (
            <span key={effort ?? 'default'}>
              {effort ? LABELS[effort] : 'Default'}
            </span>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
