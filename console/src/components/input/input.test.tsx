import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Input } from './index';

describe('Input', () => {
  it('renders an <input type="text"> by default with data-slot', () => {
    render(<Input data-testid="control" />);
    const input = screen.getByTestId('control') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('text');
    expect(input.getAttribute('data-slot')).toBe('input');
  });

  it('respects the type prop', () => {
    render(<Input type="email" data-testid="control" />);
    expect((screen.getByTestId('control') as HTMLInputElement).type).toBe(
      'email',
    );
  });

  it('reflects the size prop via data-size and accepts sm', () => {
    const { rerender } = render(<Input data-testid="control" />);
    expect(screen.getByTestId('control').getAttribute('data-size')).toBe(
      'default',
    );

    rerender(<Input size="sm" data-testid="control" />);
    expect(screen.getByTestId('control').getAttribute('data-size')).toBe('sm');
  });

  it('reports changes through onChange when wired to state', () => {
    function Controlled() {
      const [value, setValue] = useState('');
      return (
        <Input
          data-testid="control"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }

    render(<Controlled />);
    const input = screen.getByTestId('control') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(input.value).toBe('hello');
  });

  it('inherits id, disabled and aria-describedby from the Field context', () => {
    render(
      <Field controlId="name-field" disabled>
        <FieldLabel>Name</FieldLabel>
        <Input data-testid="control" />
        <FieldDescription>Min 2 chars</FieldDescription>
      </Field>,
    );

    const input = screen.getByTestId('control') as HTMLInputElement;
    expect(input.id).toBe('name-field');
    expect(input.disabled).toBe(true);
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ').filter(Boolean)).toHaveLength(1);
    expect(screen.getByText('Min 2 chars').id).toBe(describedBy);
  });

  it('marks itself aria-invalid and chains the error id when the Field is invalid', () => {
    render(
      <Field invalid>
        <FieldLabel>Email</FieldLabel>
        <Input data-testid="control" />
        <FieldError>Required</FieldError>
      </Field>,
    );

    const input = screen.getByTestId('control') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = (input.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean);
    expect(ids).toContain(screen.getByRole('alert').id);
  });

  it('lets caller props override Field context (id, disabled, aria-invalid)', () => {
    render(
      <Field controlId="from-field" disabled invalid>
        <FieldLabel>Override</FieldLabel>
        <Input
          data-testid="control"
          id="from-consumer"
          disabled={false}
          aria-invalid={false}
        />
      </Field>,
    );

    const input = screen.getByTestId('control') as HTMLInputElement;
    expect(input.id).toBe('from-consumer');
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('merges caller className with the base style', () => {
    render(<Input className="custom" data-testid="control" />);
    expect(screen.getByTestId('control').className).toContain('custom');
  });
});
