import { type ComponentProps, useCallback, useMemo } from 'react';
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
  // A bare calendar date ("YYYY-MM-DD" — what `<input type="date">` emits) is
  // parsed by `new Date` as UTC midnight, which `formatForInput` then shifts
  // across the date boundary in non-UTC timezones (e.g. picking the 26th
  // renders as the 25th in the Americas). Append a local time so it's read as
  // local midnight and round-trips to the same day everywhere.
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00`
    : trimmed;
  const parsed = new Date(normalized);
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

  const report = useCallback(
    (error: string | null) => {
      field.setError(error);
      onErrorChange?.(error);
    },
    [field.setError, onErrorChange],
  );

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
        // Parse via `toDate` so a day-granularity value (a bare date) is read
        // as local midnight, consistent with how it's rendered back.
        const parsed = toDate(text);
        if (!parsed) {
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
