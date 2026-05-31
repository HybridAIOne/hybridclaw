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
import { Search, Secrets } from '../components/icons';
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

/** Most recent rotation across the set secrets, for the vault summary. */
function latestRotation(entries: AdminSecretEntry[]): string {
  let newest = 0;
  for (const entry of entries) {
    if (!entry.last_rotated_at) continue;
    const ms = new Date(entry.last_rotated_at).getTime();
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  return newest === 0
    ? 'never'
    : formatRelativeTime(new Date(newest).toISOString());
}

export function SecretsPage() {
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
      lastRotation: latestRotation(setAll),
    };
  }, [data, filter]);

  if (query.isPending) {
    return (
      <div className={styles.page}>
        <PageHeader description="Loading the runtime secret store…" />
        <div className={styles.empty}>Loading…</div>
      </div>
    );
  }

  if (query.isError || !view) {
    const forbidden =
      query.error instanceof HttpResponseError && query.error.status === 403;
    return (
      <div className={styles.page}>
        <PageHeader description="Runtime secret store" />
        <div className={styles.errorState}>
          <span className={styles.errorSeal} aria-hidden="true">
            <Secrets />
          </span>
          <div>
            <p className={styles.errorTitle}>
              {forbidden ? 'Access restricted' : 'Could not load secrets'}
            </p>
            <p className={styles.errorBody}>
              {forbidden
                ? 'You do not have permission to view secret metadata.'
                : `Failed to load secrets: ${getErrorMessage(query.error)}`}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const canOverwrite = data?.actions.includes('secret.overwrite') ?? false;
  const canUnset = data?.actions.includes('secret.unset') ?? false;

  return (
    <div className={styles.page}>
      <PageHeader
        description="Runtime credential store — write-only, never read back."
        actions={
          <div className={styles.search}>
            <Search className={styles.searchIcon} aria-hidden="true" />
            <input
              className={styles.searchInput}
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by name"
              aria-label="Filter secrets by name"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        }
      />

      <section className={styles.vault} aria-label="Write-only vault notice">
        <span className={styles.vaultSeal} aria-hidden="true">
          <Secrets />
        </span>
        <div className={styles.vaultBody}>
          <h2 className={styles.vaultTitle}>Write-only vault</h2>
          <p className={styles.vaultText}>
            Values are sealed on the way in. The gateway returns only metadata —
            a length and a fingerprint — never the secret itself. Rotation
            overwrites the stored value; it never reveals it, not even to you.
          </p>
        </div>
        <dl className={styles.vaultStats}>
          <div className={styles.vaultStat}>
            <dt>Sealed</dt>
            <dd>{view.setAll.length}</dd>
          </div>
          <div className={styles.vaultStat}>
            <dt>Declared</dt>
            <dd>{view.unsetAll.length}</dd>
          </div>
          <div className={styles.vaultStat}>
            <dt>Last rotation</dt>
            <dd className={styles.vaultStatSmall}>{view.lastRotation}</dd>
          </div>
        </dl>
      </section>

      <SecretsSection
        title="Set"
        caption="Value stored — shown only as a fingerprint."
        entries={view.setEntries}
        totalCount={view.setAll.length}
        emptyLabel="No secrets are currently set."
        canOverwrite={canOverwrite}
        canUnset={canUnset}
        onOverwrite={(name) => setOverwriteTarget(name)}
        onUnset={(name) => setUnsetTarget(name)}
      />

      <SecretsSection
        title="Declared but unset"
        caption="Referenced by a skill, connector, or provider, with no value yet."
        entries={view.unsetEntries}
        totalCount={view.unsetAll.length}
        emptyLabel="No declared-but-unset secrets."
        canOverwrite={canOverwrite}
        canUnset={false}
        onOverwrite={(name) => setOverwriteTarget(name)}
        onUnset={() => undefined}
      />

      <OverwriteDialog
        name={overwriteTarget}
        wasSet={
          overwriteTarget !== null &&
          view.setAll.some((entry) => entry.name === overwriteTarget)
        }
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

function SecretsSection(props: {
  title: string;
  caption: string;
  entries: AdminSecretEntry[];
  totalCount: number;
  emptyLabel: string;
  canOverwrite: boolean;
  canUnset: boolean;
  onOverwrite: (name: string) => void;
  onUnset: (name: string) => void;
}) {
  const hidden = props.totalCount - props.entries.length;

  return (
    <section className={styles.section} aria-label={props.title}>
      <div className={styles.sectionHeader}>
        <div className={styles.sectionHeading}>
          <h2 className={styles.sectionTitle}>{props.title}</h2>
          <span className={styles.sectionCount}>{props.totalCount}</span>
        </div>
        <p className={styles.sectionCaption}>{props.caption}</p>
      </div>

      {props.entries.length === 0 ? (
        <div className={styles.empty}>
          {props.totalCount === 0
            ? props.emptyLabel
            : `No matches${hidden > 0 ? ` (${hidden} hidden)` : ''}.`}
        </div>
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
    <li className={`${styles.row} ${isSet ? styles.rowSet : styles.rowUnset}`}>
      <span
        className={styles.dot}
        data-state={isSet ? 'sealed' : 'declared'}
        aria-hidden="true"
      />

      <div className={styles.rowBody}>
        <span className={styles.name}>{entry.name}</span>
        {isSet ? (
          <div className={styles.meta}>
            <span
              className={styles.seal}
              title={
                entry.fingerprint ? formatFingerprint(entry) : 'no fingerprint'
              }
            >
              <Secrets className={styles.sealIcon} aria-hidden="true" />
              <code className={styles.sealText}>
                {formatFingerprint(entry)}
              </code>
            </span>
            <span className={styles.metaItem}>{formatLength(entry)}</span>
            <span
              className={styles.metaItem}
              title={entry.last_rotated_at ?? undefined}
            >
              rotated {formatTimestamp(entry.last_rotated_at)}
            </span>
          </div>
        ) : (
          <span className={styles.declaredNote}>
            Declared by a skill, connector, or provider — awaiting a value.
          </span>
        )}
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
  wasSet: boolean;
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
            <span className={styles.dialogSeal} aria-hidden="true">
              <Secrets />
            </span>
            {props.wasSet ? 'Rotate' : 'Set'} <code>{props.name}</code>
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
