import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, type ComboboxOption } from './index';

const FRUITS: ReadonlyArray<ComboboxOption> = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry', description: 'Stone fruit' },
];

function Harness(props: {
  initialValue?: string;
  onValueChange?: (value: string) => void;
  allowFreeText?: boolean;
}) {
  const [value, setValue] = useState(props.initialValue ?? 'banana');
  return (
    <Combobox
      aria-label="fruit"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        props.onValueChange?.(next);
      }}
      options={FRUITS}
      allowFreeText={props.allowFreeText}
    />
  );
}

describe('Combobox', () => {
  it('renders the input with the currently-selected label', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.value).toBe('Banana');
  });

  it('snaps the input back on blur when free text is disallowed and the typed value is not a match', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'xyz' } });
    fireEvent.blur(input);
    expect(input.value).toBe('Banana');
  });

  it('commits free text on blur when allowFreeText is true', () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} allowFreeText />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'custom-value' } });
    fireEvent.blur(input);
    expect(onValueChange).toHaveBeenCalledWith('custom-value');
  });

  it('snaps to a fresh matching option when the user types its full label', () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Apple' } });
    fireEvent.blur(input);
    expect(onValueChange).toHaveBeenCalledWith('apple');
    expect(input.value).toBe('Apple');
  });
});
