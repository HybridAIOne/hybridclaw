import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Field, FieldLabel } from '../field';
import { getHiddenInput } from '../test-utils';
import { Switch } from './index';

describe('Switch', () => {
  it('reflects checked state via aria-checked and data-state', () => {
    const { rerender } = render(<Switch checked={false} />);
    const button = screen.getByRole('switch');
    expect(button.getAttribute('aria-checked')).toBe('false');
    expect(button.getAttribute('data-state')).toBe('unchecked');

    rerender(<Switch checked={true} />);
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(button.getAttribute('data-state')).toBe('checked');
  });

  it('invokes onCheckedChange with the next value on click', () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('toggles when wired to React state', () => {
    function Controlled() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onCheckedChange={setOn} />;
    }

    render(<Controlled />);
    const button = screen.getByRole('switch');
    expect(button.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(button);
    expect(button.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(button);
    expect(button.getAttribute('aria-checked')).toBe('false');
  });

  it('does not invoke onCheckedChange when disabled', () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch checked={false} disabled onCheckedChange={onCheckedChange} />,
    );

    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('renders a hidden form input only when checked', () => {
    const { rerender, container } = render(
      <Switch checked={false} name="enabled" />,
    );
    expect(getHiddenInput(container)).toBeNull();

    rerender(<Switch checked={true} name="enabled" />);
    const hidden = getHiddenInput(container);
    expect(hidden).not.toBeNull();
    expect(hidden?.name).toBe('enabled');
    expect(hidden?.value).toBe('on');
  });

  it('uses a custom value attribute when supplied', () => {
    const { container } = render(
      <Switch checked={true} name="rag" value="enabled" />,
    );
    expect(getHiddenInput(container)?.value).toBe('enabled');
  });

  it('omits the hidden input when disabled, matching native submit semantics', () => {
    const { container } = render(
      <Switch checked={true} disabled name="enabled" />,
    );
    expect(getHiddenInput(container)).toBeNull();
  });

  it('sets aria-required only when required is true', () => {
    const { rerender } = render(<Switch checked={false} />);
    const button = screen.getByRole('switch');
    expect(button.getAttribute('aria-required')).toBeNull();

    rerender(<Switch checked={false} required />);
    expect(button.getAttribute('aria-required')).toBe('true');
  });

  it('inherits aria-required from a required surrounding Field', () => {
    render(
      <Field required>
        <FieldLabel>Notifications</FieldLabel>
        <Switch checked={false} />
      </Field>,
    );
    expect(screen.getByRole('switch').getAttribute('aria-required')).toBe(
      'true',
    );
  });
});
