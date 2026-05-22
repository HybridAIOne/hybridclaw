import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { pattern } from '../field/validators';
import { Input } from '../input';
import { Switch } from '../switch';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useForm,
} from './index';

type Draft = {
  email: string;
  ops: { healthPort: number };
  enabled: boolean;
  consent: boolean;
};

function makeSource(): Draft {
  return {
    email: '',
    ops: { healthPort: 0 },
    enabled: false,
    consent: false,
  };
}

describe('FormField + useForm({source}) — shadcn-style composition', () => {
  it('reads value from the draft and writes through field.onChange', () => {
    function App() {
      const form = useForm({ source: makeSource() });
      return (
        <Form form={form} aria-label="settings">
          <FormField
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
              </FormItem>
            )}
          />
          <span data-testid="dirty">{form.isDirty ? 'dirty' : 'clean'}</span>
          <span data-testid="value">{form.draft?.email ?? '∅'}</span>
        </Form>
      );
    }
    render(<App />);
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.getByTestId('value').textContent).toBe('');
    expect(screen.getByTestId('dirty').textContent).toBe('clean');
    fireEvent.change(input, { target: { value: 'a@b.co' } });
    expect(input.value).toBe('a@b.co');
    expect(screen.getByTestId('value').textContent).toBe('a@b.co');
    expect(screen.getByTestId('dirty').textContent).toBe('dirty');
  });

  it('runs rules on every change and gates error visibility on touched', () => {
    function App() {
      const form = useForm({ source: makeSource() });
      return (
        <Form form={form} aria-label="settings">
          <FormField<Draft, string>
            name="email"
            rules={[pattern(/.+@.+/, 'Must look like an email.')]}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <Input {...field} />
                <FormMessage />
              </FormItem>
            )}
          />
        </Form>
      );
    }
    render(<App />);
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    expect(screen.queryByText('Must look like an email.')).toBeNull();
    fireEvent.change(input, { target: { value: 'nope' } });
    expect(screen.getByText('Must look like an email.')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'a@b.co' } });
    expect(screen.queryByText('Must look like an email.')).toBeNull();
  });

  it('propagates required and disabled into the rendered control', () => {
    function App({
      required,
      disabled,
    }: {
      required?: boolean;
      disabled?: boolean;
    }) {
      const form = useForm({ source: makeSource() });
      return (
        <Form form={form} aria-label="settings">
          <FormField
            name="email"
            required={required}
            disabled={disabled}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <Input data-testid="email" {...field} />
              </FormItem>
            )}
          />
        </Form>
      );
    }
    const { rerender } = render(<App required disabled />);
    const input = screen.getByTestId('email') as HTMLInputElement;
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.disabled).toBe(true);
    rerender(<App />);
    expect(input.getAttribute('aria-required')).toBeNull();
    expect(input.disabled).toBe(false);
  });

  it('submit-time validate-all blocks invalid submits but lets valid ones through', () => {
    const onSubmit = vi.fn();
    function App() {
      const form = useForm({ source: makeSource() });
      return (
        <Form form={form} onSubmit={onSubmit} aria-label="settings">
          <FormField
            name="email"
            required
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <Input {...field} />
                <FormMessage />
              </FormItem>
            )}
          />
          <button type="submit">Save</button>
        </Form>
      );
    }
    render(<App />);
    expect(screen.queryByText('Required.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Required.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'a@b.co' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('binds value-shape primitives via field.value + onChange in both directions', () => {
    function App() {
      const form = useForm({ source: makeSource() });
      return (
        <Form form={form} aria-label="settings">
          <FormField
            name="enabled"
            render={({ field }) => (
              <FormItem orientation="horizontal">
                <Switch
                  checked={Boolean(field.value)}
                  onCheckedChange={field.onChange}
                  data-testid="switch"
                />
                <FormLabel>Enabled</FormLabel>
              </FormItem>
            )}
          />
          <span data-testid="enabled">
            {form.draft?.enabled ? 'on' : 'off'}
          </span>
        </Form>
      );
    }
    render(<App />);
    expect(screen.getByTestId('enabled').textContent).toBe('off');
    fireEvent.click(screen.getByTestId('switch'));
    expect(screen.getByTestId('enabled').textContent).toBe('on');
    fireEvent.click(screen.getByTestId('switch'));
    expect(screen.getByTestId('enabled').textContent).toBe('off');
  });

  it('extracts target.checked from checkbox events instead of target.value', () => {
    function App() {
      const form = useForm({ source: makeSource() });
      return (
        <Form form={form} aria-label="settings">
          <FormField
            name="consent"
            render={({ field }) => (
              <input
                type="checkbox"
                data-testid="consent"
                checked={Boolean(field.value)}
                onChange={field.onChange}
              />
            )}
          />
          <span data-testid="consent-out">
            {form.draft?.consent ? 'yes' : 'no'}
          </span>
        </Form>
      );
    }
    render(<App />);
    expect(screen.getByTestId('consent-out').textContent).toBe('no');
    fireEvent.click(screen.getByTestId('consent'));
    expect(screen.getByTestId('consent-out').textContent).toBe('yes');
    fireEvent.click(screen.getByTestId('consent'));
    expect(screen.getByTestId('consent-out').textContent).toBe('no');
  });

  it('reset() clears the error AND rehydrates the draft from source', () => {
    function App() {
      const form = useForm({ source: makeSource() });
      return (
        <>
          <Form form={form} aria-label="settings">
            <FormField
              name="email"
              required
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <Input {...field} />
                  <FormMessage />
                </FormItem>
              )}
            />
            <button type="submit">Save</button>
          </Form>
          <button
            type="button"
            onClick={() => {
              form.discard();
              form.reset();
            }}
          >
            Reset
          </button>
          <span data-testid="dirty">{form.isDirty ? 'dirty' : 'clean'}</span>
          <span data-testid="value">{form.draft?.email ?? '∅'}</span>
        </>
      );
    }
    render(<App />);
    // First force an error so we can prove reset() clears it.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Required.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'edited@example.com' },
    });
    expect(screen.getByTestId('dirty').textContent).toBe('dirty');
    expect(screen.getByTestId('value').textContent).toBe('edited@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.queryByText('Required.')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('');
    expect(screen.getByTestId('dirty').textContent).toBe('clean');
  });

  it('accepts a function as children (alternative to the render prop)', () => {
    function App() {
      const form = useForm({ source: makeSource() });
      return (
        <Form form={form} aria-label="settings">
          <FormField name="email">
            {({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <Input data-testid="via-children" {...field} />
              </FormItem>
            )}
          </FormField>
        </Form>
      );
    }
    render(<App />);
    const input = screen.getByTestId('via-children') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hi@example.com' } });
    expect(input.value).toBe('hi@example.com');
  });

  it('throws when used outside <Form> with no explicit form prop', () => {
    function Stray() {
      return (
        <FormField name="email" render={({ field }) => <input {...field} />} />
      );
    }
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    expect(() => render(<Stray />)).toThrow(
      /FormField requires either a `form` prop/,
    );
    consoleError.mockRestore();
  });

  it('FormDescription renders alongside the field for context', () => {
    function App() {
      const form = useForm({ source: makeSource() });
      return (
        <Form form={form} aria-label="settings">
          <FormField
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <Input {...field} />
                <FormDescription>We won't share it.</FormDescription>
              </FormItem>
            )}
          />
        </Form>
      );
    }
    render(<App />);
    expect(screen.getByText("We won't share it.")).toBeTruthy();
  });
});
