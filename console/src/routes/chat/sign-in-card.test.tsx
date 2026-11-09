/**
 * The sign-in card sends the username and password only to `/api/sign-ins`;
 * the chat gets a message without them. Only the latest turn's ask shows.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatUiMessage, TraceStep } from './chat-ui-message';
import { pendingSignIn, SignInCard, signInSavedMessage } from './sign-in-card';

const requestJson = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ requestJson }));

function trace(id: string, steps: TraceStep[]): ChatUiMessage {
  return {
    id,
    role: 'trace',
    content: '',
    sessionId: 's',
    steps,
    done: true,
    startedAt: 0,
  } as ChatUiMessage;
}
const asked = (host: string): TraceStep => ({
  kind: 'tool',
  toolName: 'browser_sign_in',
  status: 'done',
  signIn: { host },
});
const user = { id: 'u', role: 'user', content: 'hi', sessionId: 's' };

describe('pendingSignIn', () => {
  it.each([
    ['the latest ask', [trace('t1', [asked('shop.example')])], 't1'],
    [
      'the last ask of the latest trace',
      [trace('t1', [asked('a.example'), asked('shop.example')])],
      't1',
    ],
    [
      'nothing once the user wrote again',
      [trace('t1', [asked('shop.example')]), user],
      null,
    ],
    [
      'nothing for a trace without an ask',
      [trace('t1', [{ kind: 'draft', text: 'x' }])],
      null,
    ],
  ])('finds %s', (_label, messages, traceId) => {
    const found = pendingSignIn(messages as ChatUiMessage[]);
    expect(found?.traceId ?? null).toBe(traceId);
    if (traceId) expect(found?.host).toBe('shop.example');
  });
});

describe('SignInCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestJson.mockResolvedValue({});
  });

  it('saves to the store and tells the chat only that it is saved', async () => {
    const onSaved = vi.fn().mockResolvedValue(true);
    render(
      <SignInCard
        host="shop.example"
        token="test-key"
        disabled={false}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'pat@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'pw-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save sign-in' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('shop.example'));
    expect(requestJson).toHaveBeenCalledWith('/api/sign-ins', {
      token: 'test-key',
      method: 'POST',
      body: {
        host: 'shop.example',
        username: 'pat@example.com',
        password: 'pw-123',
      },
    });
    const message = signInSavedMessage('shop.example');
    expect(message).not.toContain('pw-123');
    expect(message).not.toContain('pat@example.com');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('shows the error and does not continue when the save fails', async () => {
    requestJson.mockRejectedValue(new Error('Missing sign_ins.manage'));
    const onSaved = vi.fn();
    render(
      <SignInCard
        host="shop.example"
        token="test-key"
        disabled={false}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'pw-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save sign-in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Missing sign_ins.manage',
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('cannot save without a password or while disabled', () => {
    const { rerender } = render(
      <SignInCard
        host="shop.example"
        token="test-key"
        disabled={false}
        onSaved={vi.fn()}
      />,
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Save sign-in',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    rerender(
      <SignInCard
        host="shop.example"
        token="test-key"
        disabled
        onSaved={vi.fn()}
      />,
    );
    expect(
      (screen.getByLabelText('Password') as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
