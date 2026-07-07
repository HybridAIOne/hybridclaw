import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useMemo, useRef, useState } from 'react';
import {
  createAdminApiToken,
  fetchAdminApiTokens,
  HttpResponseError,
  revokeAdminApiToken,
} from '../api/client';
import type {
  AdminApiTokenCreatePayload,
  AdminApiTokenEntry,
  AdminApiTokensResponse,
} from '../api/types';
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
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatRelativeTime } from '../lib/format';
import styles from './secrets.module.css';

function formatTimestamp(value: string | null): string {
  if (!value) return 'never';
  return formatRelativeTime(value);
}

function formatTokenStatus(token: AdminApiTokenEntry): string {
  if (token.revoked_at) return 'Revoked';
  if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) {
    return 'Expired';
  }
  return 'Active';
}

function formatClaims(claims: Record<string, unknown>): string {
  return (
    Object.entries(claims)
      .map(([key, value]) => {
        if (Array.isArray(value)) return `${key}: ${value.join(', ')}`;
        return `${key}: ${String(value)}`;
      })
      .join(' | ') || 'actions: none'
  );
}

function splitActions(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function TokensPage() {
  const { token } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AdminApiTokenEntry | null>(
    null,
  );
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const query = useQuery<AdminApiTokensResponse, Error>({
    queryKey: ['admin', 'tokens', token],
    queryFn: () => fetchAdminApiTokens(token),
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'tokens'] });

  const createMutation = useMutation({
    mutationFn: (payload: AdminApiTokenCreatePayload) =>
      createAdminApiToken(token, payload),
    onSuccess: async (response) => {
      setCreatedToken(response.token);
      setCreateOpen(false);
      toast.success(`Created ${response.apiToken.label}.`);
      await invalidate();
    },
    onError: (error) => {
      toast.error(`Create failed: ${getErrorMessage(error)}`);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeAdminApiToken(token, id),
    onSuccess: async (response) => {
      toast.success(`Revoked ${response.apiToken.label}.`);
      setRevokeTarget(null);
      await invalidate();
    },
    onError: (error) => {
      toast.error(`Revoke failed: ${getErrorMessage(error)}`);
    },
  });

  const view = useMemo(() => {
    const tokens = query.data?.tokens ?? [];
    const needle = filter.trim().toLowerCase();
    return needle
      ? tokens.filter(
          (entry) =>
            entry.id.includes(needle) ||
            entry.label.toLowerCase().includes(needle),
        )
      : tokens;
  }, [filter, query.data?.tokens]);

  if (query.isPending) {
    return (
      <div className="page-stack">
        <PageHeader description="Scoped API tokens" />
        <div className="empty-state">Loading API tokens...</div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    const forbidden =
      query.error instanceof HttpResponseError && query.error.status === 403;
    return (
      <div className="page-stack">
        <PageHeader description="Scoped API tokens" />
        <div className="empty-state">
          {forbidden
            ? 'You do not have permission to view API tokens.'
            : `Failed to load API tokens: ${getErrorMessage(query.error)}`}
        </div>
      </div>
    );
  }

  const canCreate = query.data.actions.includes('admin.tokens.create');
  const canRevoke = query.data.actions.includes('admin.tokens.revoke');

  return (
    <div className="page-stack">
      <PageHeader
        description="Revocable bearer tokens with scoped RBAC claims."
        actions={
          <div className={styles.actions}>
            <input
              className="compact-search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter tokens"
              aria-label="Filter tokens by label or id"
            />
            {canCreate ? (
              <Button type="button" onClick={() => setCreateOpen(true)}>
                Create token
              </Button>
            ) : null}
          </div>
        }
      />

      {view.length === 0 ? (
        <div className="empty-state">
          {query.data.tokens.length === 0
            ? 'No API tokens have been created.'
            : 'No API tokens match this filter.'}
        </div>
      ) : (
        <div className="table-shell">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Status</th>
                <th>Claims</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Expires</th>
                {canRevoke ? (
                  <th className={styles.actionsHead}>Actions</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {view.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <strong className={styles.name}>{entry.label}</strong>
                    <br />
                    <code className={styles.fingerprint}>{entry.id}</code>
                  </td>
                  <td>{formatTokenStatus(entry)}</td>
                  <td>{formatClaims(entry.claims)}</td>
                  <td title={entry.created_at}>
                    {formatTimestamp(entry.created_at)}
                  </td>
                  <td title={entry.last_used_at ?? undefined}>
                    {formatTimestamp(entry.last_used_at)}
                  </td>
                  <td title={entry.expires_at ?? undefined}>
                    {formatTimestamp(entry.expires_at)}
                  </td>
                  {canRevoke ? (
                    <td>
                      <div className={styles.actions}>
                        {!entry.revoked_at ? (
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            onClick={() => setRevokeTarget(entry)}
                          >
                            Revoke
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

      <CreateTokenDialog
        open={createOpen}
        pending={createMutation.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(payload) => createMutation.mutate(payload)}
      />
      <RevokeTokenDialog
        token={revokeTarget}
        pending={revokeMutation.isPending}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget.id);
        }}
      />
      <CreatedTokenDialog
        token={createdToken}
        onClose={() => setCreatedToken(null)}
      />
    </div>
  );
}

function CreateTokenDialog(props: {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (payload: AdminApiTokenCreatePayload) => void;
}) {
  const labelRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLInputElement>(null);
  const expiresRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const roleId = useId();
  const actionsId = useId();
  const expiresId = useId();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = labelRef.current?.value.trim() || '';
    const role = roleRef.current?.value.trim() || '';
    const actions = splitActions(actionsRef.current?.value || '');
    const expiresAt = expiresRef.current?.value.trim() || '';
    if (!label || (!role && actions.length === 0)) return;
    props.onSubmit({
      label,
      ...(role ? { role } : {}),
      ...(actions.length > 0 ? { actions } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogContent
        role="dialog"
        size="default"
        preventCloseOnOutsideClick={props.pending}
      >
        <DialogHeader>
          <DialogTitle>Create API token</DialogTitle>
          <DialogDescription>
            The token value is shown once after creation.
          </DialogDescription>
        </DialogHeader>
        <form className={styles.overwriteForm} onSubmit={handleSubmit}>
          <Field>
            <FieldLabel htmlFor={labelId}>Label</FieldLabel>
            <Input id={labelId} ref={labelRef} disabled={props.pending} />
          </Field>
          <Field>
            <FieldLabel htmlFor={actionsId}>Actions</FieldLabel>
            <Input
              id={actionsId}
              ref={actionsRef}
              placeholder="openai.api, chat.send"
              disabled={props.pending}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={roleId}>Role</FieldLabel>
            <Input
              id={roleId}
              ref={roleRef}
              placeholder="admin:auditor"
              disabled={props.pending}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={expiresId}>Expires at</FieldLabel>
            <Input
              id={expiresId}
              ref={expiresRef}
              type="datetime-local"
              disabled={props.pending}
            />
          </Field>
          <DialogFooter>
            <DialogClose className="ghost-button" disabled={props.pending}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={props.pending}>
              {props.pending ? 'Creating...' : 'Create token'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevokeTokenDialog(props: {
  token: AdminApiTokenEntry | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const open = props.token !== null;
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
          <DialogTitle>Revoke {props.token?.label}?</DialogTitle>
          <DialogDescription>
            Existing clients using this token will be rejected immediately.
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
            {props.pending ? 'Revoking...' : 'Revoke token'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreatedTokenDialog(props: {
  token: string | null;
  onClose: () => void;
}) {
  const open = props.token !== null;
  const tokenId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogContent role="dialog" size="default">
        <DialogHeader>
          <DialogTitle>API token created</DialogTitle>
          <DialogDescription>
            Store this value before closing the dialog.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={tokenId}>Token</FieldLabel>
          <Textarea
            id={tokenId}
            readOnly
            value={props.token || ''}
            className={styles.tokenValue}
            rows={3}
          />
        </Field>
        <DialogFooter>
          <Button type="button" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
