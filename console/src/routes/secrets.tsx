import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useCallback, useId, useRef, useState } from 'react';
import {
  fetchAdminSecrets,
  HttpResponseError,
  overwriteAdminSecret,
  unsetAdminSecret,
} from '../api/client';
import type { AdminSecretEntry, AdminSecretsResponse } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import { Field, FieldLabel } from '../components/field';
import { Input } from '../components/input';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatRelativeTime } from '../lib/format';
import styles from './secrets.module.css';

function formatLength(entry: AdminSecretEntry): string {
  return entry.length === null ? '—' : `${entry.length} bytes`;
}

function formatFingerprint(entry: AdminSecretEntry): string {
  return entry.fingerprint
    ? `sha256:${entry.fingerprint.sha256_prefix}`
    : 'no fingerprint';
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'never';
  return formatRelativeTime(value);
}

export function SecretsPage() {
  const { token } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [overwriteTarget, setOverwriteTarget] = useState<string | null>(null);
  const [unsetTarget, setUnsetTarget] = useState<string | null>(null);

  const query = useQuery<AdminSecretsResponse, Error>({
    queryKey: ['admin', 'secrets', token],
    queryFn: () => fetchAdminSecrets(token),
    retry: false,
  });

  const invalidate = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: ['admin', 'secrets'] });
  }, [queryClient]);

  const overwriteMutation = useMutation({
    mutationFn: (variables: { name: string; value: string; wasSet: boolean }) =>
      overwriteAdminSecret(token, variables.name, variables.value),
    onSuccess: async (_, variables) => {
      toast.success(
        variables.wasSet
          ? `Rotated ${variables.name}.`
          : `Set ${variables.name}.`,
      );
      setOverwriteTarget(null);
      await invalidate();
    },
    onError: (error) => {
      toast.error(`Overwrite failed: ${getErrorMessage(error)}`);
    },
  });

  const unsetMutation = useMutation({
    mutationFn: (name: string) => unsetAdminSecret(token, name),
    onSuccess: async (_, name) => {
      toast.success(`Removed ${name}.`);
      setUnsetTarget(null);
      await invalidate();
    },
    onError: (error) => {
      toast.error(`Unset failed: ${getErrorMessage(error)}`);
    },
  });

  if (query.isPending) {
    return (
      <div className={styles.page}>
        <PageHeader description="Loading…" />
      </div>
    );
  }

  if (query.isError) {
    const forbidden =
      query.error instanceof HttpResponseError && query.error.status === 403;
    return (
      <div className={styles.page}>
        <PageHeader description="Runtime secrets" />
        <div className={styles.empty}>
          {forbidden
            ? 'You do not have permission to view secret metadata.'
            : `Failed to load secrets: ${getErrorMessage(query.error)}`}
        </div>
      </div>
    );
  }

  const data = query.data;
  const setEntries = data.secrets.filter((entry) => entry.state === 'set');
  const unsetEntries = data.secrets.filter((entry) => entry.state === 'unset');
  const canOverwrite = data.actions.includes('secret.overwrite');
  const canUnset = data.actions.includes('secret.unset');

  return (
    <div className={styles.page}>
      <PageHeader description="Rotate or remove runtime secrets. Values are never displayed." />

      <div className={styles.contractBanner}>
        <strong>Write-only surface.</strong> Stored values are never returned to
        the browser. Overwrite replaces the current value; the new value is sent
        to the gateway and discarded from the page after submit.
      </div>

      <SecretsSection
        title="Set"
        entries={setEntries}
        emptyLabel="No secrets are currently set."
        canOverwrite={canOverwrite}
        canUnset={canUnset}
        onOverwrite={(name) => setOverwriteTarget(name)}
        onUnset={(name) => setUnsetTarget(name)}
      />

      <SecretsSection
        title="Declared but unset"
        entries={unsetEntries}
        emptyLabel="No declared-but-unset secrets."
        canOverwrite={canOverwrite}
        canUnset={false}
        onOverwrite={(name) => setOverwriteTarget(name)}
        onUnset={() => undefined}
      />

      <OverwriteDialog
        name={overwriteTarget}
        onClose={() => setOverwriteTarget(null)}
        pending={overwriteMutation.isPending}
        onSubmit={(value) => {
          if (!overwriteTarget) return;
          const wasSet =
            data.secrets.find((entry) => entry.name === overwriteTarget)
              ?.state === 'set';
          overwriteMutation.mutate({ name: overwriteTarget, value, wasSet });
        }}
      />

      <UnsetDialog
        name={unsetTarget}
        onClose={() => setUnsetTarget(null)}
        pending={unsetMutation.isPending}
        onConfirm={() => {
          if (unsetTarget) {
            unsetMutation.mutate(unsetTarget);
          }
        }}
      />
    </div>
  );
}

function SecretsSection(props: {
  title: string;
  entries: AdminSecretEntry[];
  emptyLabel: string;
  canOverwrite: boolean;
  canUnset: boolean;
  onOverwrite: (name: string) => void;
  onUnset: (name: string) => void;
}) {
  return (
    <section className={styles.section} aria-label={props.title}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{props.title}</h2>
        <span className={styles.sectionCount}>
          {props.entries.length}
          {props.entries.length === 1 ? ' entry' : ' entries'}
        </span>
      </div>

      {props.entries.length === 0 ? (
        <div className={styles.empty}>{props.emptyLabel}</div>
      ) : (
        <ul className={styles.list}>
          {props.entries.map((entry) => (
            <SecretRow
              key={entry.name}
              entry={entry}
              canOverwrite={props.canOverwrite}
              canUnset={props.canUnset && entry.state === 'set'}
              onOverwrite={() => props.onOverwrite(entry.name)}
              onUnset={() => props.onUnset(entry.name)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SecretRow(props: {
  entry: AdminSecretEntry;
  canOverwrite: boolean;
  canUnset: boolean;
  onOverwrite: () => void;
  onUnset: () => void;
}) {
  const { entry } = props;
  const isSet = entry.state === 'set';

  return (
    <li className={`${styles.row} ${isSet ? '' : styles.rowUnset}`}>
      <div>
        <div className={styles.name}>{entry.name}</div>
        <div className={styles.meta}>
          {isSet ? (
            <>
              <span>
                <span className={styles.metaLabel}>Length</span>
                <span className={styles.metaValue}>{formatLength(entry)}</span>
              </span>
              <span>
                <span className={styles.metaLabel}>Fingerprint</span>
                <span
                  className={`${styles.metaValue} ${styles.fingerprint}`}
                  title={
                    entry.fingerprint ? formatFingerprint(entry) : undefined
                  }
                >
                  {formatFingerprint(entry)}
                </span>
              </span>
              <span>
                <span className={styles.metaLabel}>Rotated</span>
                <span
                  className={styles.metaValue}
                  title={entry.last_rotated_at ?? undefined}
                >
                  {formatTimestamp(entry.last_rotated_at)}
                </span>
              </span>
            </>
          ) : (
            <span>Declared by a skill, connector, or provider.</span>
          )}
        </div>
      </div>
      <div className={styles.actions}>
        {props.canOverwrite ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onOverwrite}
          >
            {isSet ? 'Rotate' : 'Set'}
          </Button>
        ) : null}
        {props.canUnset ? (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={props.onUnset}
          >
            Unset
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function OverwriteDialog(props: {
  name: string | null;
  onClose: () => void;
  pending: boolean;
  onSubmit: (value: string) => void;
}) {
  const open = props.name !== null;
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const noteId = useId();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    const value = input.value;
    if (!value.trim()) return;
    // Keep the value in the (masked) field until the mutation resolves: on
    // success the dialog unmounts and disposes it, on close onOpenChange clears
    // it, and on error it survives so the operator can retry without retyping.
    props.onSubmit(value);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (inputRef.current) inputRef.current.value = '';
          props.onClose();
        }
      }}
    >
      <DialogContent
        role="dialog"
        size="default"
        preventCloseOnOutsideClick={props.pending}
      >
        <DialogHeader>
          <DialogTitle>
            Set value for <code>{props.name}</code>
          </DialogTitle>
          <DialogDescription>
            The new value is sent to the gateway and immediately discarded from
            this form. There is no way to read the stored value back.
          </DialogDescription>
        </DialogHeader>
        <form className={styles.overwriteForm} onSubmit={handleSubmit}>
          <Field>
            <FieldLabel htmlFor={inputId}>New value</FieldLabel>
            <Input
              id={inputId}
              ref={inputRef}
              type="password"
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
              aria-describedby={noteId}
              disabled={props.pending}
            />
            <p id={noteId} className={styles.overwriteNote}>
              Pasted value is not echoed. Once submitted, the value lives only
              in the runtime secret store; this page cannot show it again.
            </p>
          </Field>
          <DialogFooter>
            <DialogClose className="ghost-button" disabled={props.pending}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={props.pending}>
              {props.pending ? 'Saving…' : 'Save value'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UnsetDialog(props: {
  name: string | null;
  onClose: () => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const open = props.name !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogContent
        role="alertdialog"
        size="default"
        preventCloseOnOutsideClick={props.pending}
      >
        <DialogHeader>
          <DialogTitle>
            Unset <code>{props.name}</code>?
          </DialogTitle>
          <DialogDescription>
            The stored value will be removed from the runtime secret store.
            Skills or connectors that depend on this secret will fail their
            preflight checks until a new value is set.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose className="ghost-button" disabled={props.pending}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant="danger"
            disabled={props.pending}
            onClick={props.onConfirm}
          >
            {props.pending ? 'Removing…' : 'Unset secret'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
