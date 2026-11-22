/**
 * The web chat's cards for what the agent's browser needs from the user:
 * - Sign in (`browser_sign_in`): the username and password go to
 *   `POST /api/sign-ins` and into the encrypted store, bound to the host.
 * - Card details (`browser_fill_payment`): number, expiry and security code go
 *   to `POST /api/payment-cards`, held in gateway memory for ten minutes.
 * Neither enters the chat, the transcript or the model; the follow-up message
 * only says they are in, which is the agent's cue to call its tool again.
 *
 * Only the latest turn's ask gets a card (`pendingBrowserAsk`); once the user
 * writes again the ask is over. NOT a general secret prompt: hosts only.
 */
import { type FormEvent, useState } from 'react';
import { requestJson } from '../../api/client';
import { Button } from '../../components/button';
import { getErrorMessage } from '../../lib/error-message';
import type { ChatUiMessage } from './chat-ui-message';
import css from './review-card.module.css';

export type BrowserAskKind = 'signIn' | 'paymentCard';

/** The trace whose last turn ended asking for a sign-in or a card, and its host. */
export function pendingBrowserAsk(
  messages: readonly ChatUiMessage[],
): { traceId: ChatUiMessage['id']; host: string; kind: BrowserAskKind } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user') return null;
    if (msg?.role !== 'trace') continue;
    for (let j = msg.steps.length - 1; j >= 0; j--) {
      const step = msg.steps[j];
      if (step?.kind !== 'tool') continue;
      if (step.signIn) {
        return { traceId: msg.id, host: step.signIn.host, kind: 'signIn' };
      }
      if (step.paymentCard) {
        return {
          traceId: msg.id,
          host: step.paymentCard.host,
          kind: 'paymentCard',
        };
      }
    }
  }
  return null;
}

export function browserAskDoneMessage(
  kind: BrowserAskKind,
  host: string,
): string {
  return kind === 'signIn'
    ? `I saved my sign-in for ${host}. Please continue.`
    : `I entered my card for ${host}. Please continue.`;
}

interface AskField {
  name: string;
  label: string;
  autoComplete: string;
  type?: 'password';
  inputMode?: 'numeric';
  placeholder?: string;
  required: boolean;
}

interface AskCardProps {
  host: string;
  token: string;
  disabled: boolean;
  onSaved: (host: string) => Promise<boolean>;
}

function AskCard(
  props: AskCardProps & {
    title: string;
    note: string;
    path: string;
    button: string;
    fields: AskField[];
  },
) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inactive = busy || props.disabled;
  const complete = props.fields.every(
    (field) => !field.required || values[field.name],
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (inactive || !complete) return;
    setBusy(true);
    setError('');
    try {
      await requestJson(props.path, {
        token: props.token,
        method: 'POST',
        body: {
          host: props.host,
          ...Object.fromEntries(
            props.fields.map((field) => [field.name, values[field.name] ?? '']),
          ),
        },
      });
      setValues({});
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
      aria-label={props.title}
      onSubmit={(event) => void save(event)}
    >
      <strong>{props.title}</strong>
      <p>{props.note}</p>
      <div className={css.details}>
        {props.fields.map((field) => {
          const id = `${props.path}:${props.host}:${field.name}`;
          return (
            <div key={field.name}>
              <label htmlFor={id}>{field.label}</label>
              <input
                id={id}
                type={field.type}
                inputMode={field.inputMode}
                autoComplete={field.autoComplete}
                placeholder={field.placeholder}
                value={values[field.name] ?? ''}
                disabled={inactive}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
              />
            </div>
          );
        })}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className={css.actions}>
        <Button size="sm" type="submit" disabled={inactive || !complete}>
          {props.button}
        </Button>
      </div>
    </form>
  );
}

export function SignInCard(props: AskCardProps) {
  return (
    <AskCard
      {...props}
      title={`Sign in to ${props.host}`}
      note="Saved encrypted for this site only. The agent types it into the page and never sees it."
      path="/api/sign-ins"
      button="Save sign-in"
      fields={[
        {
          name: 'username',
          label: 'Username',
          autoComplete: 'username',
          required: false,
        },
        {
          name: 'password',
          label: 'Password',
          type: 'password',
          autoComplete: 'current-password',
          required: true,
        },
      ]}
    />
  );
}

export function PaymentCard(props: AskCardProps) {
  return (
    <AskCard
      {...props}
      title={`Card for ${props.host}`}
      note="Used for this site only and forgotten after ten minutes. The agent types it into the page and never sees it."
      path="/api/payment-cards"
      button="Use card"
      fields={[
        {
          name: 'number',
          label: 'Card number',
          inputMode: 'numeric',
          autoComplete: 'cc-number',
          required: true,
        },
        {
          name: 'expiry',
          label: 'Expiry',
          autoComplete: 'cc-exp',
          placeholder: 'MM/YY',
          required: true,
        },
        {
          name: 'cvc',
          label: 'Security code',
          type: 'password',
          inputMode: 'numeric',
          autoComplete: 'cc-csc',
          required: true,
        },
      ]}
    />
  );
}
