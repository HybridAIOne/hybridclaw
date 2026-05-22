import { type ComponentProps, useEffect, useState } from 'react';
import { useStableCallback } from '../../lib/use-stable-callback';
import { useFieldContext } from '../field/context';
import { Input } from '../input';

export type NumberFieldProps = Omit<
  ComponentProps<typeof Input>,
  'value' | 'onChange' | 'type' | 'inputMode' | 'min' | 'max' | 'step'
> & {
  value: number;
  onValueChange: (value: number) => void;
  /**
   * Called whenever the visible error state changes. `null` means the input
   * is currently valid.
   */
  onErrorChange?: (error: string | null) => void;
  /** Restrict to integers; rejects fractional input. */
  integer?: boolean;
  min?: number;
  max?: number;
  /**
   * Step size for browser-driven increments (ArrowUp / ArrowDown on
   * `<input type="number">`). Has no effect in decimal mode.
   */
  step?: number;
  /**
   * Value committed when the user clears the input. If omitted, an empty
   * input is treated as required and surfaces `'Required.'` without
   * committing anything.
   */
  emptyValue?: number;
  /** Override the default `'Required.'` message when empty is rejected. */
  requiredMessage?: string;
};

/**
 * Numeric input that maintains its own raw-string state so partially-typed
 * values like `"0."` remain visible mid-edit. Validates on every keystroke
 * (integer, min, max). When the value is valid, calls `onValueChange`. When
 * invalid, calls `onErrorChange(message)` and does NOT call `onValueChange`,
 * so the parent's committed value is never silently coerced.
 *
 * For aria/error visuals, wrap this in a `<Field invalid={Boolean(error)}>`
 * and render a `<FieldError>{error}</FieldError>` alongside.
 */
export function NumberField({
  value,
  onValueChange,
  onErrorChange,
  integer,
  min,
  max,
  step,
  emptyValue,
  requiredMessage = 'Required.',
  ...inputProps
}: NumberFieldProps) {
  const [rawValue, setRawValue] = useState(() => String(value));
  const field = useFieldContext();
  // useStableCallback already keeps the latest closure via a ref, so
  // wrapping the inline merger in useCallback would be redundant.
  const reportError = useStableCallback((next: string | null) => {
    field.setError(next);
    onErrorChange?.(next);
  });

  useEffect(() => {
    setRawValue(String(value));
    reportError(null);
  }, [value, reportError]);

  const validate = (text: string): { value?: number; error: string | null } => {
    if (text.trim() === '') {
      if (emptyValue !== undefined) return { value: emptyValue, error: null };
      return { error: requiredMessage };
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      return { error: 'Enter a valid number.' };
    }
    if (integer && !Number.isInteger(parsed)) {
      return { error: 'Enter a whole number.' };
    }
    if (min !== undefined && parsed < min) {
      return { error: `Must be ≥ ${min}.` };
    }
    if (max !== undefined && parsed > max) {
      return { error: `Must be ≤ ${max}.` };
    }
    return { value: parsed, error: null };
  };

  return (
    <Input
      {...inputProps}
      type={integer ? 'number' : 'text'}
      inputMode={integer ? 'numeric' : 'decimal'}
      min={min}
      max={max}
      step={integer ? step : undefined}
      value={rawValue}
      onBlur={(event) => {
        // Decimal mode allows trailing "." mid-typing; on blur, if the value
        // didn't parse as finite, restore the last committed value so the
        // input doesn't display garbage when the user clicks away.
        if (!integer) {
          const parsed = Number(rawValue);
          if (!Number.isFinite(parsed)) {
            setRawValue(String(value));
            reportError(null);
          }
        }
        inputProps.onBlur?.(event);
      }}
      onChange={(event) => {
        const next = event.target.value;
        setRawValue(next);
        const result = validate(next);
        reportError(result.error);
        if (result.error === null && result.value !== undefined) {
          onValueChange(result.value);
        }
      }}
    />
  );
}
