import { fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DateField } from './index';

function Harness(props: {
  initial?: Date | null;
  onChange?: (value: Date | null) => void;
  onErrorChange?: (error: string | null) => void;
  granularity?: 'day' | 'minute' | 'second';
  required?: boolean;
  min?: Date | string;
  max?: Date | string;
}) {
  const [value, setValue] = useState<Date | null>(props.initial ?? null);
  return (
    <DateField
      aria-label="date"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
      onErrorChange={props.onErrorChange}
      granularity={props.granularity}
      required={props.required}
      min={props.min}
      max={props.max}
    />
  );
}

describe('DateField', () => {
  it('renders an empty datetime-local input by default', () => {
    render(<Harness />);
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.value).toBe('');
  });

  it('uses a date input when granularity is day', () => {
    render(<Harness granularity="day" />);
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('date');
  });

  it('commits a valid datetime as a Date object', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-05-22T09:30' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const committed = onChange.mock.calls[0][0] as Date;
    expect(committed).toBeInstanceOf(Date);
    expect(committed.getFullYear()).toBe(2026);
    expect(committed.getMonth()).toBe(4); // May
    expect(committed.getDate()).toBe(22);
  });

  it('treats empty input as null when not required', () => {
    const onChange = vi.fn();
    render(
      <Harness onChange={onChange} initial={new Date('2026-05-22T09:30:00')} />,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('reports an error when required and the input is cleared', () => {
    const onError = vi.fn();
    render(<Harness required onErrorChange={onError} initial={new Date()} />);
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(onError).toHaveBeenLastCalledWith('Required.');
  });

  it('round-trips a day-granularity date to the same calendar day', () => {
    // Regression: a bare "YYYY-MM-DD" was parsed as UTC midnight, which the
    // local-time renderer then shifted back a day in timezones behind UTC.
    // The displayed day must match the supplied day in every timezone.
    render(
      <DateField
        aria-label="date"
        granularity="day"
        value="2026-05-26"
        onValueChange={() => {}}
      />,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('2026-05-26');
  });

  it('commits a day-granularity selection as the picked calendar day', () => {
    const onChange = vi.fn();
    render(<Harness granularity="day" onChange={onChange} />);
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-05-26' } });
    const committed = onChange.mock.calls[0]?.[0] as Date;
    expect(committed.getFullYear()).toBe(2026);
    expect(committed.getMonth()).toBe(4); // May
    expect(committed.getDate()).toBe(26); // local day, not shifted to the 25th
  });

  it('rejects timestamps earlier than min', () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    render(
      <Harness
        onChange={onChange}
        onErrorChange={onError}
        min={new Date('2026-01-01T00:00:00')}
      />,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2025-12-31T23:59' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith(
      'Date is earlier than the minimum allowed.',
    );
  });
});
