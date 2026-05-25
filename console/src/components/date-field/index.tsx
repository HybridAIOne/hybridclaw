import { type ComponentProps, useEffect, useMemo } from 'react';
import { useStableCallback } from '../../lib/use-stable-callback';
import { useFieldContext } from '../field/context';
import { Input } from '../input';

export type DateFieldGranularity = 'day' | 'minute' | 'second';

export type DateFieldProps = Omit<
  ComponentProps<typeof Input>,
  'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'
> & {
  /**
   * The committed value as either a `Date`, an ISO string, or `null` when
   * empty. Strings are parsed via `new Date(...)`. Invalid input leaves
   * `value` unchanged and surfaces a field-level error.
   */
  value: Date | string | null;
  onValueChange: (value: Date | null) => void;
  onErrorChange?: (error: string | null) => void;
  /**
   * `'day'` uses an `<input type="date">`, `'minute'` (the default) uses
   * `<input type="datetime-local">`, `'second'` adds seconds precision.
   */
  granularity?: DateFieldGranularity;
  /**
   * Earliest acceptable timestamp. Same forms accepted as `value`.
   */
  min?: Date | string;
  /** Latest acceptable timestamp. */
  max?: Date | string;
  /** When the field is empty, fail with this message. Defaults off. */
  required?: boolean;
};

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatForInput(
  date: Date | null,
  granularity: DateFieldGranularity,
): string {
  if (!date) return '';
  // Render in the local timezone so the user sees the wall-clock time
  // they entered, not the UTC translation.
  const offsetMs = date.getTimezoneOffset() * 60_000;
  const local = new Date(date.getTime() - offsetMs);
  const iso = local.toISOString();
  if (granularity === 'day') return iso.slice(0, 10);
  if (granularity === 'second') return iso.slice(0, 19);
  return iso.slice(0, 16);
}

/**
 * Date / datetime input primitive. Always commits a `Date` (or `null`)
 * regardless of how the value is supplied. Validates against optional
 * min/max bounds and surfaces an error via the surrounding `<Field>`'s
 * context.
 *
 *   <Field>
 *     <FieldLabel>Run at</FieldLabel>
 *     <DateField granularity="minute" value={draft.runAt}
 *       onValueChange={(d) => setDraft({ ...draft, runAt: d })} />
 *     <FieldError />
 *   </Field>
 */
export function DateField({
  value,
  onValueChange,
  onErrorChange,
  granularity = 'minute',
  min,
  max,
  required = false,
  ...inputProps
}: DateFieldProps) {
  const field = useFieldContext();
  const inputType = granularity === 'day' ? 'date' : 'datetime-local';
  const step = granularity === 'second' ? 1 : undefined;

  const minDate = useMemo(() => toDate(min ?? null), [min]);
  const maxDate = useMemo(() => toDate(max ?? null), [max]);
  const currentDate = useMemo(() => toDate(value), [value]);
  const inputValue = formatForInput(currentDate, granularity);

  // useStableCallback keeps the latest closure via a ref (matching
  // NumberField), so the reporter has a constant identity and is safe to
  // depend on from the resync effect below.
  const report = useStableCallback((error: string | null) => {
    field.setError(error);
    onErrorChange?.(error);
  });

  useEffect(() => {
    // Only user input ever *sets* an error. When the committed value changes
    // externally (form reset, server commit) to something valid — or to empty
    // while optional — clear any stale error left from earlier invalid input.
    // A bad value the user just typed never reaches here because invalid input
    // doesn't call onValueChange, so `value` (and thus currentDate) is unchanged.
    if (currentDate === null) {
      if (!required) report(null);
      return;
    }
    if (minDate && currentDate < minDate) return;
    if (maxDate && currentDate > maxDate) return;
    report(null);
  }, [currentDate, minDate, maxDate, required, report]);

  return (
    <Input
      {...inputProps}
      type={inputType}
      step={step}
      value={inputValue}
      min={minDate ? formatForInput(minDate, granularity) : undefined}
      max={maxDate ? formatForInput(maxDate, granularity) : undefined}
      onChange={(event) => {
        const text = event.target.value;
        if (text.trim() === '') {
          if (required) {
            report('Required.');
            return;
          }
          report(null);
          onValueChange(null);
          return;
        }
        const parsed = new Date(text);
        if (Number.isNaN(parsed.getTime())) {
          report('Enter a valid date.');
          return;
        }
        if (minDate && parsed < minDate) {
          report('Date is earlier than the minimum allowed.');
          return;
        }
        if (maxDate && parsed > maxDate) {
          report('Date is later than the maximum allowed.');
          return;
        }
        report(null);
        onValueChange(parsed);
      }}
    />
  );
}
