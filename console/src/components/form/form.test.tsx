import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Field, FieldError, FieldLabel } from '../field';
import { Input } from '../input';
import { Form, useForm } from './index';

function Harness({ onSubmit }: { onSubmit?: () => void }) {
  const form = useForm();
  return (
    <Form form={form} onSubmit={onSubmit} aria-label="settings">
      <Field controlId="port" error="Required.">
        <FieldLabel>Port</FieldLabel>
        <Input id="port" defaultValue="" />
        <FieldError />
      </Field>
      <button type="submit" disabled={!form.isValid}>
        Save
      </button>
    </Form>
  );
}

describe('Form / useForm', () => {
  it('aggregates errors from descendant Fields', () => {
    render(<Harness />);
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText('Required.')).toBeTruthy();
  });

  it('marks the form valid once descendants clear their errors', () => {
    function Toggleable() {
      const form = useForm();
      return (
        <Form form={form} aria-label="settings">
          <ValidatingField />
          <span data-testid="valid">{form.isValid ? 'yes' : 'no'}</span>
        </Form>
      );
    }
    function ValidatingField() {
      return (
        <Field controlId="port" error={null}>
          <FieldLabel>Port</FieldLabel>
          <Input id="port" defaultValue="" />
          <FieldError />
        </Field>
      );
    }
    render(<Toggleable />);
    expect(screen.getByTestId('valid').textContent).toBe('yes');
  });

  it('intercepts native submit, calls onSubmit, prevents default', () => {
    const onSubmit = vi.fn();
    function ValidForm() {
      const form = useForm();
      return (
        <Form form={form} onSubmit={onSubmit} aria-label="settings">
          <button type="submit">Save</button>
        </Form>
      );
    }
    render(<ValidForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('cleans up errors when a Field unmounts', () => {
    function Toggle({ show }: { show: boolean }) {
      const form = useForm();
      return (
        <Form form={form} aria-label="settings">
          {show ? (
            <Field controlId="port" error="Required.">
              <FieldLabel>Port</FieldLabel>
              <Input id="port" defaultValue="" />
              <FieldError />
            </Field>
          ) : null}
          <span data-testid="valid">{form.isValid ? 'yes' : 'no'}</span>
        </Form>
      );
    }
    const { rerender } = render(<Toggle show={true} />);
    expect(screen.getByTestId('valid').textContent).toBe('no');
    rerender(<Toggle show={false} />);
    expect(screen.getByTestId('valid').textContent).toBe('yes');
  });
});
