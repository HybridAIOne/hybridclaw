import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NumberField } from './index';

function setup(props: Partial<React.ComponentProps<typeof NumberField>> = {}) {
  const onValueChange = vi.fn<(value: number) => void>();
  const onErrorChange = vi.fn<(error: string | null) => void>();
  render(
    <NumberField
      aria-label="amount"
      value={props.value ?? 0}
      onValueChange={onValueChange}
      onErrorChange={onErrorChange}
      {...props}
    />,
  );
  return {
    input: screen.getByRole(
      props.integer ? 'spinbutton' : 'textbox',
    ) as HTMLInputElement,
    onValueChange,
    onErrorChange,
  };
}

describe('NumberField', () => {
  it('commits valid integer input and clears the error', () => {
    const { input, onValueChange, onErrorChange } = setup({
      integer: true,
      min: 1,
      max: 100,
      value: 1,
    });
    fireEvent.change(input, { target: { value: '42' } });
    expect(onValueChange).toHaveBeenLastCalledWith(42);
    expect(onErrorChange).toHaveBeenLastCalledWith(null);
  });

  it('rejects values below min without committing', () => {
    const { input, onValueChange, onErrorChange } = setup({
      integer: true,
      min: 1,
      max: 100,
      value: 5,
    });
    fireEvent.change(input, { target: { value: '0' } });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onErrorChange).toHaveBeenLastCalledWith('Must be ≥ 1.');
  });

  it('rejects values above max without committing', () => {
    const { input, onValueChange, onErrorChange } = setup({
      integer: true,
      min: 1,
      max: 100,
      value: 5,
    });
    fireEvent.change(input, { target: { value: '500' } });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onErrorChange).toHaveBeenLastCalledWith('Must be ≤ 100.');
  });

  it('rejects non-integer input in integer mode', () => {
    const { input, onValueChange, onErrorChange } = setup({
      integer: true,
      value: 5,
    });
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onErrorChange).toHaveBeenLastCalledWith('Enter a whole number.');
  });

  it('preserves "0." mid-typing in decimal mode and commits 0.5 once complete', () => {
    const { input, onValueChange, onErrorChange } = setup({ value: 0 });
    fireEvent.change(input, { target: { value: '0.' } });
    // The display retains the trailing dot even though Number("0.") === 0.
    expect(input.value).toBe('0.');
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(input.value).toBe('0.5');
    expect(onValueChange).toHaveBeenLastCalledWith(0.5);
    expect(onErrorChange).toHaveBeenLastCalledWith(null);
  });

  it('commits emptyValue when the input is cleared, if emptyValue is set', () => {
    const { input, onValueChange, onErrorChange } = setup({
      value: 0.5,
      emptyValue: 0,
    });
    fireEvent.change(input, { target: { value: '' } });
    expect(onValueChange).toHaveBeenLastCalledWith(0);
    expect(onErrorChange).toHaveBeenLastCalledWith(null);
  });

  it('reports Required when the input is cleared and emptyValue is unset', () => {
    const { input, onValueChange, onErrorChange } = setup({
      integer: true,
      value: 9090,
    });
    fireEvent.change(input, { target: { value: '' } });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onErrorChange).toHaveBeenLastCalledWith('Required.');
  });

  it('snaps back to last committed value on blur if decimal text is unparseable', () => {
    const { input, onValueChange } = setup({ value: 1.5 });
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input.value).toBe('abc');
    fireEvent.blur(input);
    expect(input.value).toBe('1.5');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('resyncs rawValue when the parent updates value externally', () => {
    const onValueChange = vi.fn<(value: number) => void>();
    const { rerender } = render(
      <NumberField
        aria-label="amount"
        value={1}
        onValueChange={onValueChange}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1');
    rerender(
      <NumberField
        aria-label="amount"
        value={99}
        onValueChange={onValueChange}
      />,
    );
    expect(input.value).toBe('99');
  });
});
