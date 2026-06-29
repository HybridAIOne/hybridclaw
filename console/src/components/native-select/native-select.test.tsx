import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Field, FieldLabel } from '../field';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from './index';

describe('NativeSelect', () => {
  it('renders a real <select> with the provided children', () => {
    render(
      <NativeSelect value="b" onChange={() => {}}>
        <NativeSelectOption value="a">Alpha</NativeSelectOption>
        <NativeSelectOption value="b">Bravo</NativeSelectOption>
      </NativeSelect>,
    );

    const select = screen.getByDisplayValue('Bravo') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('b');
    expect(select.options).toHaveLength(2);
  });

  it('reports the new value through onChange when wired to state', () => {
    function Controlled() {
      const [value, setValue] = useState('a');
      return (
        <NativeSelect
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          <NativeSelectOption value="a">Alpha</NativeSelectOption>
          <NativeSelectOption value="b">Bravo</NativeSelectOption>
        </NativeSelect>
      );
    }

    render(<Controlled />);
    const select = screen.getByDisplayValue('Alpha') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'b' } });
    expect(select.value).toBe('b');
    expect(screen.getByDisplayValue('Bravo')).toBe(select);
  });

  it('does not reset a select input event before the first change event', () => {
    function ControlledInField() {
      const [value, setValue] = useState('a');
      return (
        <Field controlId="choice">
          <FieldLabel>Choice</FieldLabel>
          <NativeSelect
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            <NativeSelectOption value="a">Alpha</NativeSelectOption>
            <NativeSelectOption value="b">Bravo</NativeSelectOption>
          </NativeSelect>
        </Field>
      );
    }

    render(<ControlledInField />);
    const select = screen.getByLabelText('Choice') as HTMLSelectElement;
    fireEvent.input(select, { target: { value: 'b' } });
    fireEvent.change(select);
    expect(select.value).toBe('b');
    expect(screen.getByDisplayValue('Bravo')).toBe(select);
  });

  it('inherits id and disabled from the surrounding Field', () => {
    render(
      <Field controlId="region" disabled>
        <FieldLabel>Region</FieldLabel>
        <NativeSelect defaultValue="eu">
          <NativeSelectOption value="eu">EU</NativeSelectOption>
          <NativeSelectOption value="us">US</NativeSelectOption>
        </NativeSelect>
      </Field>,
    );

    const select = screen.getByLabelText('Region') as HTMLSelectElement;
    expect(select.id).toBe('region');
    expect(select.disabled).toBe(true);
  });

  it('lets the consumer override the inherited id', () => {
    render(
      <Field controlId="from-field">
        <FieldLabel>Override</FieldLabel>
        <NativeSelect id="from-consumer" defaultValue="a">
          <NativeSelectOption value="a">A</NativeSelectOption>
        </NativeSelect>
      </Field>,
    );

    expect((screen.getByDisplayValue('A') as HTMLSelectElement).id).toBe(
      'from-consumer',
    );
  });

  it('applies the size attribute via data-size and accepts sm', () => {
    const { rerender } = render(
      <NativeSelect defaultValue="a">
        <NativeSelectOption value="a">A</NativeSelectOption>
      </NativeSelect>,
    );
    expect(screen.getByDisplayValue('A').getAttribute('data-size')).toBe(
      'default',
    );

    rerender(
      <NativeSelect size="sm" defaultValue="a">
        <NativeSelectOption value="a">A</NativeSelectOption>
      </NativeSelect>,
    );
    expect(screen.getByDisplayValue('A').getAttribute('data-size')).toBe('sm');
  });

  it('renders NativeSelectOptGroup with a label and nested options', () => {
    render(
      <NativeSelect defaultValue="us-east">
        <NativeSelectOptGroup label="Americas">
          <NativeSelectOption value="us-east">US East</NativeSelectOption>
          <NativeSelectOption value="us-west">US West</NativeSelectOption>
        </NativeSelectOptGroup>
        <NativeSelectOptGroup label="Europe">
          <NativeSelectOption value="eu">EU</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>,
    );

    const groups = screen
      .getByDisplayValue('US East')
      .closest('select')
      ?.querySelectorAll('optgroup');
    expect(groups).toHaveLength(2);
    expect(groups?.[0].getAttribute('label')).toBe('Americas');
    expect(groups?.[1].getAttribute('label')).toBe('Europe');
  });

  it('merges caller className with the base style', () => {
    render(
      <NativeSelect className="custom-class" defaultValue="a">
        <NativeSelectOption value="a">A</NativeSelectOption>
      </NativeSelect>,
    );
    expect(screen.getByDisplayValue('A').className).toContain('custom-class');
  });
});
