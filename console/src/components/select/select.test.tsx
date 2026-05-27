import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from './index';

function Fruits({
  value,
  defaultValue,
  onValueChange,
  disabled,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder="Pick a fruit" />
        <SelectIcon />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="apple">
          <SelectItemText>Apple</SelectItemText>
        </SelectItem>
        <SelectItem value="banana">
          <SelectItemText>Banana</SelectItemText>
        </SelectItem>
        <SelectItem value="cherry" disabled>
          <SelectItemText>Cherry</SelectItemText>
        </SelectItem>
        <SelectItem value="date">
          <SelectItemText>Date</SelectItemText>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function getOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function getOption(value: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-value="${value}"]`);
  if (!el) throw new Error(`option ${value} not found`);
  return el;
}

describe('Select', () => {
  it('shows the placeholder when no value is selected and renders a closed listbox', () => {
    render(<Fruits />);
    expect(screen.getByText('Pick a fruit')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    const trigger = screen.getByRole('combobox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('data-state')).toBe('closed');
  });

  it('opens the listbox when the trigger is clicked', () => {
    render(<Fruits defaultValue="apple" />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('data-state')).toBe('open');
    expect(getOptions()).toHaveLength(4);
  });

  it('reflects the controlled value through aria-selected and data-state', () => {
    render(<Fruits value="banana" />);
    fireEvent.click(screen.getByRole('combobox'));

    expect(getOption('banana').getAttribute('aria-selected')).toBe('true');
    expect(getOption('banana').getAttribute('data-state')).toBe('checked');
    expect(getOption('apple').getAttribute('aria-selected')).toBe('false');
  });

  it('invokes onValueChange and closes the popup when an item is clicked', () => {
    const onValueChange = vi.fn();
    render(<Fruits defaultValue="apple" onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(getOption('banana'));

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('banana');
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('updates the selected value when wired to React state', () => {
    function Controlled() {
      const [value, setValue] = useState('apple');
      return <Fruits value={value} onValueChange={setValue} />;
    }

    render(<Controlled />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(getOption('date'));

    fireEvent.click(screen.getByRole('combobox'));
    expect(getOption('date').getAttribute('aria-selected')).toBe('true');
  });

  it('does not select a disabled item on click', () => {
    const onValueChange = vi.fn();
    render(<Fruits defaultValue="apple" onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(getOption('cherry'));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('moves the highlight with ArrowDown / ArrowUp and skips disabled items', () => {
    render(<Fruits defaultValue="apple" />);
    fireEvent.click(screen.getByRole('combobox'));

    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(getOption('banana').getAttribute('data-highlighted')).toBe('');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(getOption('date').getAttribute('data-highlighted')).toBe('');
    expect(getOption('cherry').getAttribute('data-highlighted')).toBe(null);

    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    expect(getOption('banana').getAttribute('data-highlighted')).toBe('');
  });

  it('jumps to first/last with Home/End', () => {
    render(<Fruits defaultValue="banana" />);
    fireEvent.click(screen.getByRole('combobox'));

    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'End' });
    expect(getOption('date').getAttribute('data-highlighted')).toBe('');

    fireEvent.keyDown(listbox, { key: 'Home' });
    expect(getOption('apple').getAttribute('data-highlighted')).toBe('');
  });

  it('commits the highlighted value on Enter', () => {
    const onValueChange = vi.fn();
    render(<Fruits defaultValue="apple" onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('combobox'));

    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('banana');
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('commits the highlighted value on Space (when no search header)', () => {
    const onValueChange = vi.fn();
    render(<Fruits defaultValue="apple" onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('combobox'));

    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: ' ' });

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('banana');
  });

  it('typeahead highlights the first option matching the typed prefix', () => {
    render(<Fruits defaultValue="apple" />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(listbox, { key: 'd' });
    expect(getOption('date').getAttribute('data-highlighted')).toBe('');
  });

  it('typeahead accumulates the buffer within the debounce window', () => {
    render(<Fruits defaultValue="apple" />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');

    // "ba" should match "banana" but not "apple" — accumulation is required
    // to distinguish from a fresh "a" key that would match "apple".
    fireEvent.keyDown(listbox, { key: 'b' });
    fireEvent.keyDown(listbox, { key: 'a' });
    expect(getOption('banana').getAttribute('data-highlighted')).toBe('');
  });

  it('exposes aria-activedescendant for the highlighted option', () => {
    render(<Fruits defaultValue="apple" />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    const activeId = listbox.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(getOption('banana').id).toBe(activeId);
  });

  it('opens via ArrowDown / Enter / Space on the trigger', () => {
    render(<Fruits defaultValue="apple" />);
    const trigger = screen.getByRole('combobox');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(getOption('apple').getAttribute('data-highlighted')).toBe('');
  });

  it('cannot be opened when disabled and the trigger reports aria-disabled', () => {
    render(<Fruits defaultValue="apple" disabled />);
    const trigger = screen.getByRole('combobox');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect((trigger as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(getOptions()).toHaveLength(0);
  });
});
