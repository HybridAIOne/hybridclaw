import { createContext, useContext, useMemo } from 'react';
import { cx } from '../../lib/cx';

type ToggleGroupContextValue = {
  value: string;
  onValueChange: (value: string) => void;
  disabled: boolean;
};

const ToggleGroupContext = createContext<ToggleGroupContextValue | null>(null);

function useToggleGroupContext(): ToggleGroupContextValue {
  const ctx = useContext(ToggleGroupContext);
  if (!ctx) {
    throw new Error('<ToggleGroupItem> must be used inside <ToggleGroup>');
  }
  return ctx;
}

// ── Root ───────────────────────────────────────────────────────────────────

export function ToggleGroup(props: {
  /** Currently selected value. */
  value: string;
  /** Called when the user selects a different item. */
  onValueChange: (value: string) => void;
  /** Accessible label for the fieldset. */
  ariaLabel: string;
  children: React.ReactNode;
  /** 'sm' renders compact padding for dense table rows; 'default' for forms. */
  size?: 'sm' | 'default';
  disabled?: boolean;
  className?: string;
}) {
  const disabled = props.disabled ?? false;
  const ctx = useMemo(
    () => ({
      value: props.value,
      onValueChange: props.onValueChange,
      disabled,
    }),
    [props.value, props.onValueChange, disabled],
  );

  return (
    <ToggleGroupContext.Provider value={ctx}>
      {/* fieldset carries implicit role="group" — biome-compliant semantic element */}
      <fieldset
        aria-label={props.ariaLabel}
        className={cx(
          'binary-toggle',
          props.size === 'sm' && 'toggle-group--sm',
          props.className,
        )}
        data-disabled={disabled || undefined}
      >
        {props.children}
      </fieldset>
    </ToggleGroupContext.Provider>
  );
}

// ── Item ───────────────────────────────────────────────────────────────────

export function ToggleGroupItem(props: {
  /** The value this item represents. Matched against ToggleGroup.value. */
  value: string;
  children: React.ReactNode;
  /**
   * Controls the selected-state colour.
   * 'is-on'  → success green (enabled / on / active)
   * 'is-off' → muted grey   (disabled / off / inactive)
   * Defaults to 'is-on'.
   */
  activeTone?: 'is-on' | 'is-off';
  /** Overrides the group-level disabled state for this item only. */
  disabled?: boolean;
}) {
  const ctx = useToggleGroupContext();
  const active = props.value === ctx.value;
  const tone = props.activeTone ?? 'is-on';
  const isDisabled = props.disabled ?? ctx.disabled;

  // data-state mirrors Radix: every item carries the attribute so CSS
  // transitions can target [data-state="on"] and [data-state="off"].
  const dataState = active ? (tone === 'is-off' ? 'off' : 'on') : 'off';

  return (
    <button
      type="button"
      aria-pressed={active}
      data-state={dataState}
      className={cx('binary-toggle-button', active && 'active', active && tone)}
      disabled={isDisabled}
      data-disabled={isDisabled || undefined}
      onClick={() => {
        if (!active && !isDisabled) {
          ctx.onValueChange(props.value);
        }
      }}
    >
      {props.children}
    </button>
  );
}
