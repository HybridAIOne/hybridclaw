import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Textarea } from './index';

describe('Textarea', () => {
  it('renders a <textarea> with data-slot', () => {
    render(<Textarea data-testid="control" />);
    const textarea = screen.getByTestId('control');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.getAttribute('data-slot')).toBe('textarea');
  });

  it('toggles the autoSize data attribute', () => {
    const { rerender } = render(<Textarea data-testid="control" />);
    expect(screen.getByTestId('control').getAttribute('data-auto-size')).toBe(
      null,
    );

    rerender(<Textarea autoSize data-testid="control" />);
    expect(screen.getByTestId('control').getAttribute('data-auto-size')).toBe(
      '',
    );
  });

  it('reports changes through onChange when wired to state', () => {
    function Controlled() {
      const [value, setValue] = useState('');
      return (
        <Textarea
          data-testid="control"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }

    render(<Controlled />);
    const textarea = screen.getByTestId('control') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'multi\nline' } });
    expect(textarea.value).toBe('multi\nline');
  });

  it('inherits id and disabled from the Field context', () => {
    render(
      <Field controlId="notes" disabled>
        <FieldLabel>Notes</FieldLabel>
        <Textarea data-testid="control" />
      </Field>,
    );

    const textarea = screen.getByTestId('control') as HTMLTextAreaElement;
    expect(textarea.id).toBe('notes');
    expect(textarea.disabled).toBe(true);
  });

  it('reflects invalid state and chains the error id into aria-describedby', () => {
    render(
      <Field invalid>
        <FieldLabel>Notes</FieldLabel>
        <Textarea data-testid="control" />
        <FieldDescription>Markdown supported</FieldDescription>
        <FieldError>Required</FieldError>
      </Field>,
    );

    const textarea = screen.getByTestId('control') as HTMLTextAreaElement;
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    const ids = (textarea.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean);
    expect(ids).toContain(screen.getByText('Markdown supported').id);
    expect(ids).toContain(screen.getByRole('alert').id);
  });

  it('respects an explicit id over the Field context', () => {
    render(
      <Field controlId="from-field">
        <FieldLabel>Override</FieldLabel>
        <Textarea id="from-consumer" data-testid="control" />
      </Field>,
    );

    expect((screen.getByTestId('control') as HTMLTextAreaElement).id).toBe(
      'from-consumer',
    );
  });

  it('merges caller className with the base style', () => {
    render(<Textarea className="custom" data-testid="control" />);
    expect(screen.getByTestId('control').className).toContain('custom');
  });
});
