import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { RadioGroup, RadioGroupItem } from './index';

describe('RadioGroup', () => {
  it('inherits disabled, invalid, and the describedby chain from the surrounding Field', () => {
    render(
      <Field invalid disabled>
        <FieldLabel>Plan</FieldLabel>
        <RadioGroup data-testid="group">
          <RadioGroupItem value="a" data-testid="item-a" />
          <RadioGroupItem value="b" data-testid="item-b" />
        </RadioGroup>
        <FieldDescription>Pick one</FieldDescription>
        <FieldError>Required</FieldError>
      </Field>,
    );

    const group = screen.getByTestId('group');
    expect(group.getAttribute('aria-invalid')).toBe('true');
    expect(group.getAttribute('aria-disabled')).toBe('true');

    const describedBy = group.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(' ').filter(Boolean);
    expect(screen.getByText('Pick one').id).toBe(ids[0]);
    expect(screen.getByText('Required').id).toBe(ids[1]);

    expect(screen.getByTestId('item-a').getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect((screen.getByTestId('item-a') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('inherits aria-required from a surrounding <Field required>', () => {
    render(
      <Field required>
        <FieldLabel>Plan</FieldLabel>
        <RadioGroup data-testid="group">
          <RadioGroupItem value="a" />
          <RadioGroupItem value="b" />
        </RadioGroup>
      </Field>,
    );

    expect(screen.getByTestId('group').getAttribute('aria-required')).toBe(
      'true',
    );
  });

  it('uses the Field-generated id on the group container', () => {
    render(
      <Field controlId="plan">
        <FieldLabel>Plan</FieldLabel>
        <RadioGroup data-testid="group">
          <RadioGroupItem value="a" />
        </RadioGroup>
      </Field>,
    );

    expect(screen.getByTestId('group').id).toBe('plan');
  });

  it('is named by the surrounding FieldLabel via aria-labelledby', () => {
    // A `role="radiogroup"` div is not labelable, so the FieldLabel's
    // `htmlFor` cannot name it; it must be wired through aria-labelledby.
    render(
      <Field controlId="plan">
        <FieldLabel>Plan</FieldLabel>
        <RadioGroup>
          <RadioGroupItem value="a" />
          <RadioGroupItem value="b" />
        </RadioGroup>
      </Field>,
    );

    expect(screen.getByRole('radiogroup', { name: 'Plan' })).toBeTruthy();
  });

  it('lets the consumer override the accessible name with aria-label', () => {
    render(
      <Field controlId="plan">
        <FieldLabel>Plan</FieldLabel>
        <RadioGroup aria-label="Billing plan">
          <RadioGroupItem value="a" />
        </RadioGroup>
      </Field>,
    );

    expect(
      screen.getByRole('radiogroup', { name: 'Billing plan' }),
    ).toBeTruthy();
  });

  it('lets the consumer override disabled even when the Field is disabled', () => {
    render(
      <Field disabled>
        <RadioGroup data-testid="group" disabled={false}>
          <RadioGroupItem value="a" data-testid="item-a" />
        </RadioGroup>
      </Field>,
    );

    expect(
      screen.getByTestId('group').getAttribute('aria-disabled'),
    ).toBeNull();
    expect((screen.getByTestId('item-a') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
