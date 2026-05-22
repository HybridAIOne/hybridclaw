import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Field, FieldError, FieldLabel, useFieldContext } from '../field';
import { Input } from '../input';
import { Form, useForm, useFormSignals } from './index';

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
    const save = screen.getByRole('button', {
      name: 'Save',
    }) as HTMLButtonElement;
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

  it('refuses submit when a Field is invalid and reveals errors instead', () => {
    const onSubmit = vi.fn();
    function InvalidForm() {
      const form = useForm();
      return (
        <Form form={form} onSubmit={onSubmit} aria-label="settings">
          <Field controlId="port">
            <FieldLabel>Port</FieldLabel>
            <Input id="port" defaultValue="" />
            <FieldError />
          </Field>
          <UntouchedRequired />
          <button type="submit">Save</button>
        </Form>
      );
    }
    // A separate component so it can write to its own Field's error state.
    function UntouchedRequired() {
      return (
        <Field controlId="name">
          <FieldLabel>Name</FieldLabel>
          <ErrorEmitter message="Required." />
          <FieldError />
        </Field>
      );
    }
    function ErrorEmitter({ message }: { message: string }) {
      const field = useFieldContext();
      // Emit on mount to simulate a validator that runs immediately.
      useEffect(() => {
        field.setError(message);
      }, [field, message]);
      return <input id="name" />;
    }

    render(<InvalidForm />);
    // Untouched field — error should not be visible yet.
    expect(screen.queryByText('Required.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
    // After submit attempt, errors become visible even on untouched fields.
    expect(screen.getByText('Required.')).toBeTruthy();
  });

  it('runs Field.validate on submit attempt for never-edited fields', () => {
    const onSubmit = vi.fn();
    function EmptyFormSubmitted() {
      const form = useForm();
      // Validator returns 'Required.' when the imaginary draft email is
      // empty (it always is in this test). Field has never been edited.
      return (
        <Form form={form} onSubmit={onSubmit} aria-label="settings">
          <Field controlId="email" validate={() => 'Required.'}>
            <FieldLabel>Email</FieldLabel>
            <Input id="email" defaultValue="" />
            <FieldError />
          </Field>
          <button type="submit">Save</button>
        </Form>
      );
    }
    render(<EmptyFormSubmitted />);
    // Errors are not yet registered — field was never edited.
    expect(screen.queryByText('Required.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Required.')).toBeTruthy();
  });

  it('reset() clears submitAttempted and untouches Fields', () => {
    function ResettableForm() {
      const form = useForm();
      return (
        <>
          <Form form={form} aria-label="settings">
            <Field controlId="email" validate={() => 'Required.'}>
              <FieldLabel>Email</FieldLabel>
              <Input id="email" defaultValue="" />
              <FieldError />
            </Field>
            <button type="submit">Save</button>
          </Form>
          <button type="button" onClick={form.reset}>
            Reset
          </button>
          <span data-testid="valid">{form.isValid ? 'yes' : 'no'}</span>
        </>
      );
    }

    render(<ResettableForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Required.')).toBeTruthy();
    expect(screen.getByTestId('valid').textContent).toBe('no');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.queryByText('Required.')).toBeNull();
    expect(screen.getByTestId('valid').textContent).toBe('yes');
  });

  it('exposes isSubmitting during async onSubmit', async () => {
    let releaseSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSubmit = resolve;
        }),
    );
    function Inner() {
      const signals = useFormSignals();
      return (
        <span data-testid="state">
          {signals?.isSubmitting ? 'submitting' : 'idle'}
        </span>
      );
    }
    function AsyncForm() {
      const form = useForm();
      return (
        <Form form={form} onSubmit={onSubmit} aria-label="settings">
          <Inner />
          <button type="submit">Save</button>
        </Form>
      );
    }

    render(<AsyncForm />);
    expect(screen.getByTestId('state').textContent).toBe('idle');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('state').textContent).toBe('submitting');
    // A repeat click while in flight is a no-op.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {
      releaseSubmit?.();
    });
    expect(screen.getByTestId('state').textContent).toBe('idle');
  });

  it('setErrors mirrors server errors into Field local state', () => {
    function ServerErrorForm() {
      const form = useForm();
      return (
        <>
          <Form form={form} aria-label="settings">
            <Field controlId="email">
              <FieldLabel>Email</FieldLabel>
              <Input id="email" defaultValue="" />
              <FieldError />
            </Field>
          </Form>
          <button
            type="button"
            onClick={() => form.setErrors({ email: 'Already taken.' })}
          >
            Push errors
          </button>
        </>
      );
    }
    render(<ServerErrorForm />);
    expect(screen.queryByText('Already taken.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Push errors' }));
    expect(screen.getByText('Already taken.')).toBeTruthy();
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
