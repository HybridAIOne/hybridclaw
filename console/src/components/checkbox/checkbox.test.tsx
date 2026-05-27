import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getHiddenInput } from '../test-utils';
import { Checkbox, type CheckedState } from './index';

describe('Checkbox', () => {
  it('reflects boolean checked state via aria-checked and data-state', () => {
    const { rerender } = render(<Checkbox checked={false} />);
    const button = screen.getByRole('checkbox');
    expect(button.getAttribute('aria-checked')).toBe('false');
    expect(button.getAttribute('data-state')).toBe('unchecked');

    rerender(<Checkbox checked={true} />);
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(button.getAttribute('data-state')).toBe('checked');
  });

  it('represents indeterminate state with aria-checked=mixed', () => {
    render(<Checkbox checked="indeterminate" />);
    const button = screen.getByRole('checkbox');
    expect(button.getAttribute('aria-checked')).toBe('mixed');
    expect(button.getAttribute('data-state')).toBe('indeterminate');
  });

  it('transitions indeterminate to checked on click', () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox checked="indeterminate" onCheckedChange={onCheckedChange} />,
    );

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('toggles checked → unchecked when wired to React state', () => {
    function Controlled() {
      const [state, setState] = useState<CheckedState>(false);
      return <Checkbox checked={state} onCheckedChange={setState} />;
    }

    render(<Controlled />);
    const button = screen.getByRole('checkbox');

    fireEvent.click(button);
    expect(button.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(button);
    expect(button.getAttribute('aria-checked')).toBe('false');
  });

  it('does not invoke onCheckedChange when disabled', () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox checked={false} disabled onCheckedChange={onCheckedChange} />,
    );

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('renders a hidden form input only when checked', () => {
    const { rerender, container } = render(
      <Checkbox checked={false} name="agreed" />,
    );
    expect(getHiddenInput(container)).toBeNull();

    rerender(<Checkbox checked="indeterminate" name="agreed" />);
    expect(getHiddenInput(container)).toBeNull();

    rerender(<Checkbox checked={true} name="agreed" value="yes" />);
    const hidden = getHiddenInput(container);
    expect(hidden?.name).toBe('agreed');
    expect(hidden?.value).toBe('yes');
  });

  it('omits the hidden input when disabled, matching native submit semantics', () => {
    const { container } = render(
      <Checkbox checked={true} disabled name="agreed" />,
    );
    expect(getHiddenInput(container)).toBeNull();
  });

  it('sets aria-required only when required is true', () => {
    const { rerender } = render(<Checkbox checked={false} />);
    const button = screen.getByRole('checkbox');
    expect(button.getAttribute('aria-required')).toBeNull();

    rerender(<Checkbox checked={false} required />);
    expect(button.getAttribute('aria-required')).toBe('true');
  });
});
