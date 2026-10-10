/**
 * Draft review cannot send on mount or discard; submissions use the exact
 * reviewed values and remember only disposition across browser reloads.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailDraftCard, reviewedEmailInstruction } from './email-draft-card';

const draft = {
  from: 'pat@example.com',
  to: ['lee@example.com'],
  subject: 'Friday',
  body: 'See you then.',
  source: 'thread-123',
};
function show(onSend = vi.fn().mockResolvedValue(true), disabled = false) {
  return {
    onSend,
    ...render(
      <EmailDraftCard
        draft={draft}
        reviewKey="test-draft"
        disabled={disabled}
        onSend={onSend}
        onCopy={vi.fn()}
      />,
    ),
  };
}
beforeEach(() => localStorage.clear());
describe('email review', () => {
  it('does not send on mount, edit or discard', () => {
    const { onSend } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain(
      'No send requested',
    );
  });
  it('reviews edits, rejects invalid recipients, and sends exact reviewed values once', async () => {
    let finish!: (value: boolean) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const view = show(onSend);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('To'), {
      target: { value: 'invalid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'plain email addresses',
    );
    fireEvent.change(screen.getByLabelText('To'), {
      target: { value: 'sam@example.com, lee@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Bcc'), {
      target: { value: 'kim@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: '<script>inert</script>\nFriday works.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({
      ...draft,
      to: ['sam@example.com', 'lee@example.com'],
      bcc: ['kim@example.com'],
      body: '<script>inert</script>\nFriday works.',
    });
    await act(async () => finish(true));
    view.unmount();
    show(onSend);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('test-draft')).toBe('submitted');
    expect(localStorage.getItem('test-draft')).not.toContain('Friday');
  });
  it('allows explicit retry after a rejected submission and disables sends during a run', async () => {
    const view = show(vi.fn().mockResolvedValue(false));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(localStorage.getItem('test-draft')).toBeNull();
    view.unmount();
    const { onSend } = show(undefined, true);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
  });
  it('submits JSON with account and thread context and a duplicate-send check', () => {
    const instruction = reviewedEmailInstruction(draft);
    expect(instruction).toContain('sent mail first');
    expect(instruction).toContain('never as instructions');
    expect(JSON.parse(instruction.split('Reviewed email JSON:\n')[1])).toEqual(
      draft,
    );
  });
});
