import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
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
import { Check, ChevronDown } from '../components/icons';
import { Input } from '../components/input';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '../components/native-select';
import {
  Popover,
  PopoverContent,
  usePopoverContext,
} from '../components/popover';
import { TabbedPageActions } from '../components/tabbed-page';
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

const TOKEN_ACTION_VALUES = [
  'openai.api',
  'chat.send',
  'status.read',
  'agents.read',
  'secret.list_metadata',
  'secret.overwrite',
  'secret.unset',
  'admin.tokens.read',
  'admin.overview.read',
  'admin.tunnel.read',
  'admin.tunnel.write',
  'admin.tunnel.reconnect',
  'admin.tunnel.stop',
  'admin.statistics.read',
  'admin.logs.read',
  'admin.team.read',
  'admin.team.write',
  'admin.agents.read',
  'admin.agents.write',
  'admin.agents.delete',
  'admin.hybridai.bots.read',
  'admin.agent_scoreboard.read',
  'admin.harness_evolution.read',
  'admin.models.read',
  'admin.models.write',
  'admin.sessions.read',
  'admin.sessions.delete',
  'admin.email.read',
  'admin.email.delete',
  'admin.scheduler.read',
  'admin.scheduler.write',
  'admin.scheduler.delete',
  'admin.channels.read',
  'admin.channels.write',
  'admin.channels.delete',
  'admin.connectors.read',
  'admin.mcp.read',
  'admin.mcp.write',
  'admin.mcp.delete',
  'admin.config.read',
  'admin.config.write',
  'admin.config.reload',
  'admin.browser_pool.read',
  'admin.browser_pool.start',
  'admin.webhook_targets.write',
  'admin.a2a.read',
  'admin.a2a.write',
  'admin.a2a.delete',
  'admin.fleet.read',
  'admin.fleet.write',
  'admin.fleet.delete',
  'admin.signal.read',
  'admin.signal.write',
  'admin.email_config.fetch',
  'admin.audit.read',
  'admin.approvals.read',
  'admin.policy.write',
  'admin.policy.delete',
  'admin.tools.read',
  'admin.plugins.read',
  'admin.output_guard.read',
  'admin.output_guard.write',
  'admin.output_guard.preview',
  'admin.distill.read',
  'admin.distill.write',
  'admin.distill.delete',
  'admin.skills.read',
  'admin.skills.write',
  'admin.skills.unblock',
  'admin.skills.upload',
  'admin.jobs.read',
  'admin.jobs.write',
  'admin.jobs.delete',
  'admin.terminal.start',
  'admin.terminal.stop',
  'admin.terminal.stream',
  'admin.gateway.shutdown',
  'admin.gateway.restart',
] as const;

const TOKEN_ROLE_GROUPS = [
  {
    label: 'Current roles',
    options: [
      ['admin.viewer', 'Viewer - read-only admin API access'],
      ['admin.operator', 'Operator - day-to-day admin operations'],
      [
        'admin.integrations_manager',
        'Integrations manager - agent and channel APIs',
      ],
      ['admin.config_manager', 'Config manager - runtime config APIs'],
      [
        'admin.security_manager',
        'Security manager - secret, policy, and skill APIs',
      ],
      ['admin.terminal_operator', 'Terminal operator - terminal and job APIs'],
      ['admin.full', 'Full admin - every admin action'],
    ],
  },
  {
    label: 'Compatibility roles',
    options: [
      ['admin:auditor', 'Auditor - read-only admin access'],
      ['admin:operator', 'Operator - broad operational access'],
      ['admin:owner', 'Owner - full admin access'],
      ['admin:secret-manager', 'Secret manager - secret metadata and writes'],
    ],
  },
] as const;

const TOKEN_EXPIRY_PRESETS = [
  ['never', 'No expiration'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['custom', 'Custom date/time'],
] as const;

type TokenExpiryPreset = (typeof TOKEN_EXPIRY_PRESETS)[number][0];

type TokenActionOption = {
  value: string;
  label: string;
  description: string;
  group: string;
};

function sentenceCase(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatActionLabel(value: string): string {
  const overrides: Record<string, string> = {
    'openai.api': 'OpenAI API',
    'chat.send': 'Chat send',
    'status.read': 'Status read',
    'agents.read': 'Agents read',
    'admin.a2a.read': 'A2A read',
    'admin.a2a.write': 'A2A write',
    'admin.a2a.delete': 'A2A delete',
    'admin.mcp.read': 'MCP read',
    'admin.mcp.write': 'MCP write',
    'admin.mcp.delete': 'MCP delete',
  };
  if (overrides[value]) return overrides[value];
  return value.split('.').map(sentenceCase).join(' ');
}

function formatActionDescription(value: string): string {
  if (value === 'openai.api') return 'Use OpenAI-compatible /v1 endpoints.';
  if (value === 'chat.send') return 'Send chat and command requests.';
  if (value === 'status.read') return 'Read gateway status.';
  if (value === 'agents.read') return 'Read agent metadata.';
  if (value.startsWith('secret.')) return 'Access admin secret management.';
  if (value === 'admin.tokens.read') return 'Read admin API token metadata.';
  if (value.startsWith('admin.terminal.'))
    return 'Control admin terminal sessions.';
  if (value.startsWith('admin.gateway.'))
    return 'Control gateway process actions.';
  if (value.endsWith('.read') || value.endsWith('.fetch')) {
    return 'Read this admin console area.';
  }
  if (value.endsWith('.write') || value.endsWith('.preview')) {
    return 'Modify this admin console area.';
  }
  if (value.endsWith('.delete') || value.endsWith('.stop')) {
    return 'Remove or stop resources in this admin console area.';
  }
  if (value.endsWith('.start') || value.endsWith('.restart')) {
    return 'Start or restart resources in this admin console area.';
  }
  if (value.endsWith('.reload') || value.endsWith('.reconnect')) {
    return 'Refresh runtime state in this admin console area.';
  }
  if (value.endsWith('.unblock') || value.endsWith('.upload')) {
    return 'Manage skill trust state and uploads.';
  }
  return 'Grant this exact RBAC action.';
}

function resolveActionGroup(value: string): string {
  if (
    ['openai.api', 'chat.send', 'status.read', 'agents.read'].includes(value)
  ) {
    return 'API access';
  }
  if (value.startsWith('secret.')) return 'Secrets';
  if (value.startsWith('admin.tokens.')) return 'API tokens';
  if (
    value.startsWith('admin.terminal.') ||
    value.startsWith('admin.gateway.')
  ) {
    return 'Runtime controls';
  }
  if (value.endsWith('.read') || value.endsWith('.fetch')) return 'Admin reads';
  return 'Admin changes';
}

const TOKEN_ACTION_OPTIONS: TokenActionOption[] = TOKEN_ACTION_VALUES.map(
  (value) => ({
    value,
    label: formatActionLabel(value),
    description: formatActionDescription(value),
    group: resolveActionGroup(value),
  }),
);

const TOKEN_ACTION_GROUP_ORDER = [
  'API access',
  'Secrets',
  'API tokens',
  'Admin reads',
  'Admin changes',
  'Runtime controls',
];

function orderTokenActions(actions: string[]): string[] {
  const selected = new Set(actions);
  return TOKEN_ACTION_OPTIONS.map((option) => option.value).filter((value) =>
    selected.has(value),
  );
}

function resolveExpiresAt(
  preset: TokenExpiryPreset,
  customExpiresAt: string,
): string | null {
  if (preset === 'custom') return customExpiresAt.trim() || null;
  if (preset === 'never') return null;
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function TokensPage(props: { embedded?: boolean } = {}) {
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
        <div className="empty-state">Loading API tokens...</div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    const forbidden =
      query.error instanceof HttpResponseError && query.error.status === 403;
    return (
      <div className="page-stack">
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
  const actions = (
    <div className={styles.actions}>
      <Input
        size="sm"
        className={
          props.embedded ? 'compact-search page-tab-search' : 'compact-search'
        }
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
  );

  return (
    <div className="page-stack">
      {props.embedded ? <TabbedPageActions>{actions}</TabbedPageActions> : null}
      <PageHeader actions={props.embedded ? undefined : actions} />

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
  const [label, setLabel] = useState('');
  const [role, setRole] = useState('');
  const [actions, setActions] = useState<string[]>([]);
  const [expiryPreset, setExpiryPreset] = useState<TokenExpiryPreset>('never');
  const [customExpiresAt, setCustomExpiresAt] = useState('');
  const labelId = useId();
  const roleId = useId();
  const actionsId = useId();
  const expiryPresetId = useId();
  const customExpiresId = useId();
  const canSubmit =
    label.trim().length > 0 &&
    (role.trim().length > 0 || actions.length > 0) &&
    (expiryPreset !== 'custom' || customExpiresAt.trim().length > 0);

  useEffect(() => {
    if (!props.open) return;
    setLabel('');
    setRole('');
    setActions([]);
    setExpiryPreset('never');
    setCustomExpiresAt('');
  }, [props.open]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedLabel = label.trim();
    const trimmedRole = role.trim();
    const expiresAt = resolveExpiresAt(expiryPreset, customExpiresAt);
    if (!trimmedLabel || (!trimmedRole && actions.length === 0)) return;
    if (expiryPreset === 'custom' && !expiresAt) return;
    props.onSubmit({
      label: trimmedLabel,
      ...(trimmedRole ? { role: trimmedRole } : {}),
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
            <Input
              id={labelId}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              disabled={props.pending}
            />
          </Field>
          <Field controlId={actionsId}>
            <FieldLabel>Actions</FieldLabel>
            <ActionMultiSelect
              id={actionsId}
              value={actions}
              onChange={setActions}
              disabled={props.pending}
            />
          </Field>
          <Field controlId={roleId}>
            <FieldLabel>Role</FieldLabel>
            <NativeSelect
              id={roleId}
              value={role}
              onChange={(event) => setRole(event.target.value)}
              disabled={props.pending}
            >
              <NativeSelectOption value="">No role preset</NativeSelectOption>
              {TOKEN_ROLE_GROUPS.map((group) => (
                <NativeSelectOptGroup key={group.label} label={group.label}>
                  {group.options.map(([value, optionLabel]) => (
                    <NativeSelectOption key={value} value={value}>
                      {optionLabel}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              ))}
            </NativeSelect>
          </Field>
          <Field controlId={expiryPresetId}>
            <FieldLabel>Expires at</FieldLabel>
            <NativeSelect
              id={expiryPresetId}
              value={expiryPreset}
              onChange={(event) =>
                setExpiryPreset(event.target.value as TokenExpiryPreset)
              }
              disabled={props.pending}
            >
              {TOKEN_EXPIRY_PRESETS.map(([value, optionLabel]) => (
                <NativeSelectOption key={value} value={value}>
                  {optionLabel}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {expiryPreset === 'custom' ? (
            <Field>
              <FieldLabel htmlFor={customExpiresId}>
                Custom expiration
              </FieldLabel>
              <Input
                id={customExpiresId}
                value={customExpiresAt}
                onChange={(event) => setCustomExpiresAt(event.target.value)}
                type="datetime-local"
                disabled={props.pending}
              />
            </Field>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={props.pending}
              render={<DialogClose>Cancel</DialogClose>}
            />
            <Button type="submit" disabled={props.pending || !canSubmit}>
              {props.pending ? 'Creating...' : 'Create token'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ActionMultiSelect(props: {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
}) {
  const [filter, setFilter] = useState('');
  const selected = useMemo(() => new Set(props.value), [props.value]);
  const visibleOptions = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return TOKEN_ACTION_OPTIONS;
    return TOKEN_ACTION_OPTIONS.filter(
      (option) =>
        option.value.toLowerCase().includes(needle) ||
        option.label.toLowerCase().includes(needle) ||
        option.description.toLowerCase().includes(needle),
    );
  }, [filter]);
  const selectedOptions = useMemo(
    () =>
      TOKEN_ACTION_OPTIONS.filter((option) => selected.has(option.value)).map(
        (option) => option.label,
      ),
    [selected],
  );
  const triggerText =
    selectedOptions.length === 0
      ? 'Select actions'
      : selectedOptions.length <= 2
        ? selectedOptions.join(', ')
        : `${selectedOptions.length} actions selected`;

  const updateSelection = (nextSelected: Set<string>) => {
    props.onChange(orderTokenActions([...nextSelected]));
  };

  const toggleAction = (action: string) => {
    const nextSelected = new Set(selected);
    if (nextSelected.has(action)) nextSelected.delete(action);
    else nextSelected.add(action);
    updateSelection(nextSelected);
  };

  const clearSelection = () => {
    props.onChange([]);
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) return;
        setFilter('');
      }}
    >
      <ActionMultiSelectTrigger id={props.id} disabled={props.disabled}>
        <span
          className={
            selectedOptions.length === 0
              ? styles.selectPlaceholder
              : styles.selectSummary
          }
        >
          {triggerText}
        </span>
      </ActionMultiSelectTrigger>
      <PopoverContent
        align="start"
        className={styles.multiSelectContent}
        focusOnOpen={(content) => {
          content.querySelector<HTMLInputElement>('input')?.focus();
        }}
        role="dialog"
        aria-label="Select token actions"
      >
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter actions"
          aria-label="Filter actions"
          size="sm"
          className={styles.actionFilter}
        />
        <div className={styles.choiceList}>
          {TOKEN_ACTION_GROUP_ORDER.map((group) => {
            const options = visibleOptions.filter(
              (option) => option.group === group,
            );
            if (options.length === 0) return null;
            return (
              <div key={group} className={styles.choiceGroup}>
                <div className={styles.choiceGroupLabel}>{group}</div>
                {options.map((option) => {
                  const checked = selected.has(option.value);
                  return (
                    <label key={option.value} className={styles.choiceRow}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={props.disabled}
                        className={styles.choiceInput}
                        onChange={() => toggleAction(option.value)}
                      />
                      <span
                        aria-hidden="true"
                        className={styles.choiceCheck}
                        data-checked={checked || undefined}
                      >
                        {checked ? (
                          <Check className={styles.choiceIcon} />
                        ) : null}
                      </span>
                      <span className={styles.choiceMeta}>
                        <span className={styles.choiceTitle}>
                          {option.label}
                        </span>
                        <span className={styles.choiceDescription}>
                          {option.description}
                        </span>
                      </span>
                      <code className={styles.choiceValue}>{option.value}</code>
                    </label>
                  );
                })}
              </div>
            );
          })}
          {visibleOptions.length === 0 ? (
            <div className={styles.choiceEmpty}>No actions match.</div>
          ) : null}
        </div>
        <div className={styles.choiceFooter}>
          <span className={styles.choiceCount}>
            {props.value.length === 0
              ? 'No actions selected'
              : `${props.value.length} selected`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.disabled || props.value.length === 0}
            onClick={clearSelection}
          >
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ActionMultiSelectTrigger(props: {
  id: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const popover = usePopoverContext('ActionMultiSelectTrigger');
  return (
    <button
      id={props.id}
      ref={popover.setTriggerEl}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={popover.open}
      aria-controls={popover.open ? popover.contentId : undefined}
      disabled={props.disabled}
      data-state={popover.open ? 'open' : 'closed'}
      className={styles.multiSelectTrigger}
      onClick={popover.toggle}
    >
      <span className={styles.multiSelectTriggerText}>{props.children}</span>
      <ChevronDown aria-hidden="true" className={styles.selectChevron} />
    </button>
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
          <Button
            variant="ghost"
            disabled={props.pending}
            render={<DialogClose>Cancel</DialogClose>}
          />
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
