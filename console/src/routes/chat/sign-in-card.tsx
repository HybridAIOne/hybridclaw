/**
 * The web chat's Sign in card for `browser_sign_in`: the username and
 * password go from these fields to `POST /api/sign-ins` and into the
 * encrypted store, bound to the host. They never enter the chat, the
 * transcript or the model; the follow-up message only says the sign-in is
 * saved, which is the agent's cue to call `browser_sign_in` again.
 *
 * Only the latest turn's ask gets a card (`pendingSignIn`); once the user
 * writes again the ask is over. NOT a general secret prompt: hosts only.
 */
import { type FormEvent, useState } from 'react';
import { requestJson } from '../../api/client';
import { Button } from '../../components/button';
import { getErrorMessage } from '../../lib/error-message';
import type { ChatUiMessage } from './chat-ui-message';
import css from './review-card.module.css';

/** The trace whose last turn ended asking for a sign-in, and its host. */
export function pendingSignIn(
  messages: readonly ChatUiMessage[],
): { traceId: ChatUiMessage['id']; host: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user') return null;
    if (msg?.role !== 'trace') continue;
    for (let j = msg.steps.length - 1; j >= 0; j--) {
      const step = msg.steps[j];
      if (step?.kind === 'tool' && step.signIn) {
        return { traceId: msg.id, host: step.signIn.host };
      }
    }
  }
  return null;
}

export function signInSavedMessage(host: string): string {
  return `I saved my sign-in for ${host}. Please continue.`;
}

export function SignInCard(props: {
  host: string;
  token: string;
  disabled: boolean;
  onSaved: (host: string) => Promise<boolean>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = `sign-in:${props.host}`;
  const inactive = busy || props.disabled;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (inactive || !password) return;
    setBusy(true);
    setError('');
    try {
      await requestJson('/api/sign-ins', {
        token: props.token,
        method: 'POST',
        body: { host: props.host, username, password },
      });
      setUsername('');
      setPassword('');
      if (!(await props.onSaved(props.host))) {
        setError('Saved. Tell the agent to continue.');
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={css.card}
      aria-label={`Sign in to ${props.host}`}
      onSubmit={(event) => void save(event)}
    >
      <strong>Sign in to {props.host}</strong>
      <p>
        Saved encrypted for this site only. The agent types it into the page and
        never sees it.
      </p>
      <div className={css.details}>
        <div>
          <label htmlFor={`${id}:username`}>Username</label>
          <input
            id={`${id}:username`}
            autoComplete="username"
            value={username}
            disabled={inactive}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${id}:password`}>Password</label>
          <input
            id={`${id}:password`}
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={inactive}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className={css.actions}>
        <Button size="sm" type="submit" disabled={inactive || !password}>
          Save sign-in
        </Button>
      </div>
    </form>
  );
}
