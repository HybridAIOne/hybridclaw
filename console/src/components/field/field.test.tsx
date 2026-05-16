import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from '../input';
import { Field, FieldDescription, FieldError, FieldLabel } from './index';

describe('Field', () => {
  it('wires FieldLabel htmlFor to the inner control id', () => {
    render(
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input data-testid="control" />
      </Field>,
    );

    const label = screen.getByText('Name');
    const control = screen.getByTestId('control');
    expect(control.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(control.id);
  });

  it('respects an explicit controlId override', () => {
    render(
      <Field controlId="custom-id">
        <FieldLabel>Email</FieldLabel>
        <Input data-testid="control" />
      </Field>,
    );

    expect(screen.getByTestId('control').id).toBe('custom-id');
    expect(screen.getByText('Email').getAttribute('for')).toBe('custom-id');
  });

  it('chains aria-describedby through description and error when invalid', () => {
    render(
      <Field invalid>
        <FieldLabel>Password</FieldLabel>
        <Input data-testid="control" />
        <FieldDescription>Min 8 chars</FieldDescription>
        <FieldError>Too short</FieldError>
      </Field>,
    );

    const control = screen.getByTestId('control');
    const describedBy = control.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(' ').filter(Boolean);

    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(ids).toHaveLength(2);
    expect(screen.getByText('Min 8 chars').id).toBe(ids[0]);
    expect(screen.getByText('Too short').id).toBe(ids[1]);
  });

  it('omits the error id from aria-describedby when not invalid', () => {
    render(
      <Field>
        <FieldLabel>Password</FieldLabel>
        <Input data-testid="control" />
        <FieldDescription>Min 8 chars</FieldDescription>
      </Field>,
    );

    const control = screen.getByTestId('control');
    const describedBy = control.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(' ').filter(Boolean);

    expect(control.getAttribute('aria-invalid')).toBe(null);
    expect(ids).toHaveLength(1);
    expect(screen.getByText('Min 8 chars').id).toBe(ids[0]);
  });

  it('propagates disabled to controls without an explicit value', () => {
    render(
      <Field disabled>
        <FieldLabel>Disabled</FieldLabel>
        <Input data-testid="control" />
      </Field>,
    );

    expect((screen.getByTestId('control') as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it('renders FieldError with role=alert when content is present', () => {
    render(
      <Field invalid>
        <FieldLabel>Email</FieldLabel>
        <Input />
        <FieldError>Required</FieldError>
      </Field>,
    );

    expect(screen.getByRole('alert').textContent).toBe('Required');
  });

  it('does not render FieldError when there is no content', () => {
    render(
      <Field>
        <FieldLabel>Email</FieldLabel>
        <Input />
        <FieldError />
      </Field>,
    );

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('dedupes a list of error messages', () => {
    render(
      <Field invalid>
        <FieldLabel>Email</FieldLabel>
        <Input />
        <FieldError
          errors={[
            { message: 'Required' },
            { message: 'Required' },
            { message: 'Invalid' },
          ]}
        />
      </Field>,
    );

    const alert = screen.getByRole('alert');
    const items = alert.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('Required');
    expect(items[1].textContent).toBe('Invalid');
  });
});
