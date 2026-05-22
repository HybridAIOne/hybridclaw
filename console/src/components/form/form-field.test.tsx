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
};

function makeSource(): Draft {
  return { email: '', ops: { healthPort: 0 }, enabled: false };
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
        </Form>
      );
    }
    render(<App />);
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.getByTestId('dirty').textContent).toBe('clean');
    fireEvent.change(input, { target: { value: 'a@b.co' } });
    expect(input.value).toBe('a@b.co');
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
    // Initial render: rule fails (empty string) but field is untouched.
    expect(screen.queryByText('Must look like an email.')).toBeNull();
    // Type something invalid — the input fires `input`, which marks touched.
    fireEvent.change(input, { target: { value: 'nope' } });
    expect(screen.getByText('Must look like an email.')).toBeTruthy();
    // Type something valid — error clears.
    fireEvent.change(input, { target: { value: 'a@b.co' } });
    expect(screen.queryByText('Must look like an email.')).toBeNull();
  });

  it('auto-required adds aria-required on the control', () => {
    function App() {
      const form = useForm({ source: makeSource() });
      return (
        <Form form={form} aria-label="settings">
          <FormField
            name="email"
            required
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
    render(<App />);
    expect(screen.getByTestId('email').getAttribute('aria-required')).toBe(
      'true',
    );
  });

  it('submit-time validate-all surfaces errors on untouched FormFields', () => {
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
  });

  it('value-shape primitives bind via field.value + onChange', () => {
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
  });

  it('reset() clears the FormField error and re-syncs draft', () => {
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
        </>
      );
    }
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Required.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.queryByText('Required.')).toBeNull();
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
