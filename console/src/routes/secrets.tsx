import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type FormEvent,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { TabbedPageActions } from '../components/tabbed-page';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatRelativeTime } from '../lib/format';
import styles from './secrets.module.css';

function formatLength(entry: AdminSecretEntry): string {
  return entry.length === null ? '—' : `${entry.length} bytes`;
}

function formatFingerprint(entry: AdminSecretEntry): string {
  return entry.fingerprint ? `sha256:${entry.fingerprint.sha256_prefix}` : '—';
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'never';
  return formatRelativeTime(value);
}

export function SecretsPage(props: { embedded?: boolean } = {}) {
  const { token } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [overwriteTarget, setOverwriteTarget] = useState<string | null>(null);
  const [unsetTarget, setUnsetTarget] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

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

  const data = query.data;

  const view = useMemo(() => {
    if (!data) return null;
    const needle = filter.trim().toLowerCase();
    const setAll = data.secrets.filter((entry) => entry.state === 'set');
    const unsetAll = data.secrets.filter((entry) => entry.state === 'unset');
    const match = (entry: AdminSecretEntry) =>
      needle === '' || entry.name.toLowerCase().includes(needle);
    return {
      setAll,
      unsetAll,
      setEntries: setAll.filter(match),
      unsetEntries: unsetAll.filter(match),
    };
  }, [data, filter]);

  if (query.isPending) {
    return (
      <div className="page-stack">
        <PageHeader description="Runtime secret store" />
        <div className="empty-state">Loading the runtime secret store…</div>
      </div>
    );
  }

  if (query.isError || !view) {
    const forbidden =
      query.error instanceof HttpResponseError && query.error.status === 403;
    return (
      <div className="page-stack">
        <PageHeader description="Runtime secret store" />
        <div className="empty-state">
          {forbidden
            ? 'You do not have permission to view secret metadata.'
            : `Failed to load secrets: ${getErrorMessage(query.error)}`}
        </div>
      </div>
    );
  }

  const canOverwrite = data?.actions.includes('secret.overwrite') ?? false;
  const canUnset = data?.actions.includes('secret.unset') ?? false;
  const showSetActions = canOverwrite || canUnset;
  const filterInput = (
    <input
      className={
        props.embedded ? 'compact-search page-tab-search' : 'compact-search'
      }
      value={filter}
      onChange={(event) => setFilter(event.target.value)}
      placeholder="Filter secrets"
      aria-label="Filter secrets by name"
    />
  );

  return (
    <div className="page-stack">
      {props.embedded ? (
        <TabbedPageActions>{filterInput}</TabbedPageActions>
      ) : null}
      <PageHeader
        description="Runtime credential store. Values are write-only — set or rotate them here; they are never read back to the browser."
        actions={props.embedded ? undefined : filterInput}
      />

      <section className={styles.section} aria-label="Set">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>
            Set <span className={styles.count}>{view.setAll.length}</span>
          </h2>
          <p className={styles.caption}>
            Stored values, shown only as metadata — length and a SHA-256
            fingerprint, never the value itself.
          </p>
        </div>

        {view.setEntries.length === 0 ? (
          <div className="empty-state">
            {view.setAll.length === 0
              ? 'No secrets are currently set.'
              : 'No set secrets match this filter.'}
          </div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Length</th>
                  <th>Fingerprint</th>
                  <th>Last rotated</th>
                  {showSetActions ? (
                    <th className={styles.actionsHead}>Actions</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {view.setEntries.map((entry) => (
                  <tr key={entry.name}>
                    <td>
                      <strong className={styles.name}>{entry.name}</strong>
                    </td>
                    <td>{formatLength(entry)}</td>
                    <td>
                      <code className={styles.fingerprint}>
                        {formatFingerprint(entry)}
                      </code>
                    </td>
                    <td title={entry.last_rotated_at ?? undefined}>
                      {formatTimestamp(entry.last_rotated_at)}
                    </td>
                    {showSetActions ? (
                      <td>
                        <div className={styles.actions}>
                          {canOverwrite ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setOverwriteTarget(entry.name)}
                            >
                              Rotate
                            </Button>
                          ) : null}
                          {canUnset ? (
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              onClick={() => setUnsetTarget(entry.name)}
                            >
                              Unset
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.section} aria-label="Declared but unset">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>
            Declared but unset{' '}
            <span className={styles.count}>{view.unsetAll.length}</span>
          </h2>
          <p className={styles.caption}>
            Referenced by a skill, connector, or provider, with no value yet.
          </p>
        </div>

        {view.unsetEntries.length === 0 ? (
          <div className="empty-state">
            {view.unsetAll.length === 0
              ? 'No declared-but-unset secrets.'
              : 'No declared secrets match this filter.'}
          </div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  {canOverwrite ? (
                    <th className={styles.actionsHead}>Actions</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {view.unsetEntries.map((entry) => (
                  <tr key={entry.name}>
                    <td>
                      <strong className={styles.name}>{entry.name}</strong>
                    </td>
                    {canOverwrite ? (
                      <td>
                        <div className={styles.actions}>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setOverwriteTarget(entry.name)}
                          >
                            Set
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <OverwriteDialog
        name={overwriteTarget}
        onClose={() => setOverwriteTarget(null)}
        pending={overwriteMutation.isPending}
        onSubmit={(value) => {
          if (!overwriteTarget) return;
          const wasSet = view.setAll.some(
            (entry) => entry.name === overwriteTarget,
          );
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
