/**
 * Shared local-context controls edit prompt exposure for tools or skills.
 * Stars save per instance or agent and never enable a disabled capability.
 * Catalog visibility shares these stars but never changes prompt exposure.
 * This is separate from the permission switches in the surrounding catalogs.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useState } from 'react';
import {
  fetchLocalContextSettings,
  saveLocalContextSettings,
} from '../api/client';
import type { AdminLocalContextSettingsUpdate } from '../api/types';
import { useAuth } from '../auth';
import { getErrorMessage } from '../lib/error-message';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import styles from './local-context-settings.module.css';
import { NativeSelect } from './native-select';
import { SegmentedToggle } from './ui';

type Kind = 'tools' | 'skills';
function useSettings(kind: Kind) {
  const { token } = useAuth();
  const client = useQueryClient();
  const [agentId, setAgentId] = useState('');
  const queryKey = ['local-context-settings', kind, token];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchLocalContextSettings(token, kind),
  });
  const mutation = useMutation({
    mutationFn: (payload: AdminLocalContextSettingsUpdate) =>
      saveLocalContextSettings(token, kind, payload),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      void client.invalidateQueries({ queryKey: ['config', token] });
    },
  });
  const agent = query.data?.agents.find((entry) => entry.id === agentId);
  const starred = agent?.starred ?? query.data?.instance.starred ?? [];
  const mode = agent?.mode ?? query.data?.instance.mode ?? 'full';
  const inherited = Boolean(
    agentId && agent?.starred == null && agent?.mode == null,
  );
  const disabled =
    !query.data || mutation.isPending || Boolean(agentId && !agent);
  const save = (
    next: Pick<AdminLocalContextSettingsUpdate, 'mode' | 'starred'>,
  ) => {
    if (!disabled) mutation.mutate({ agentId: agentId || null, ...next });
  };
  return {
    kind,
    query,
    mutation,
    agentId,
    setAgentId,
    starred,
    mode,
    inherited,
    disabled,
    save,
    toggle: (name: string) => {
      const selected = starred.includes(name);
      if (!selected && starred.length >= 9) return;
      save({
        mode,
        starred: selected
          ? starred.filter((entry) => entry !== name)
          : [...starred, name],
      });
    },
  };
}
const Context = createContext<ReturnType<typeof useSettings> | null>(null);
export function useLocalContextSettings() {
  const settings = useContext(Context);
  if (!settings)
    throw new Error('Local context controls require their provider.');
  return settings;
}
export function LocalContextProvider({
  kind,
  children,
}: {
  kind: Kind;
  children: ReactNode;
}) {
  const settings = useSettings(kind);
  return <Context.Provider value={settings}>{children}</Context.Provider>;
}
export function LocalContextControls() {
  const settings = useLocalContextSettings();
  const { kind, query, mutation, starred, mode, agentId, inherited, disabled } =
    settings;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Local model {kind}</CardTitle>
      </CardHeader>
      <CardContent className={styles.content}>
        <div className={styles.controls}>
          <label className={styles.scope}>
            Apply to
            <NativeSelect
              aria-label={`Local ${kind} scope`}
              value={agentId}
              disabled={query.isPending || mutation.isPending}
              onChange={(event) => settings.setAgentId(event.target.value)}
            >
              <option value="">Instance default</option>
              {query.data?.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <SegmentedToggle
            ariaLabel={`Local ${kind} mode`}
            value={mode}
            disabled={disabled}
            options={[
              { value: 'full', label: 'Full' },
              { value: 'starred', label: 'Starred + directory' },
            ]}
            onChange={(next) => settings.save({ mode: next, starred })}
          />
          {agentId && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || inherited}
              onClick={() => settings.save({ mode: null, starred: null })}
            >
              {inherited ? 'Using instance default' : 'Use instance default'}
            </Button>
          )}
        </div>
        <p className="supporting-text">
          {kind === 'tools'
            ? 'Full sends all permitted tool schemas. Starred sends up to nine plus tool_catalog, which finds and calls the rest.'
            : 'Full lists every eligible skill. Starred lists up to nine plus the skills_list directory. Mandatory always-on skills remain included.'}{' '}
          Stars affect local model requests; permissions and enabled status
          still apply.
        </p>
        <fieldset className={styles.stars} aria-label={`Starred ${kind}`}>
          <strong>{starred.length}/9 starred</strong>
          {starred.map((name) => (
            <Button
              key={name}
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-label={`Unstar ${name}`}
              onClick={() => settings.toggle(name)}
            >
              <span aria-hidden="true" className={styles.starred}>
                ★
              </span>{' '}
              {name}
              {query.data?.disabled.includes(name) ? ' (disabled)' : ''}
            </Button>
          ))}
          {!starred.length && (
            <span className="supporting-text">
              Star entries in the catalog below.
            </span>
          )}
        </fieldset>
        {query.isPending && <p role="status">Loading local settings…</p>}
        {mutation.isPending && <p role="status">Saving…</p>}
        {mutation.isSuccess && !mutation.isPending && (
          <p role="status">Saved. Applies on the next request.</p>
        )}
        {(query.error || mutation.error) && (
          <p role="alert">{getErrorMessage(query.error || mutation.error)}</p>
        )}
      </CardContent>
    </Card>
  );
}
export function LocalContextStar({
  name,
  unavailable = false,
}: {
  name: string;
  unavailable?: boolean;
}) {
  const settings = useLocalContextSettings();
  const selected = settings.starred.includes(name);
  if (settings.kind === 'tools' && name === 'tool_catalog') return null;
  const limit = !selected && settings.starred.length >= 9;
  return (
    <button
      type="button"
      className={`${styles.starButton} ${selected ? styles.starred : styles.star}`}
      aria-label={`${selected ? 'Unstar' : 'Star'} ${name} in catalog`}
      aria-pressed={selected}
      title={
        limit
          ? 'Unstar an entry first (maximum nine).'
          : selected
            ? 'Remove from starred'
            : 'Include in the initial local prompt'
      }
      disabled={settings.disabled || limit || (!selected && unavailable)}
      onClick={() => settings.toggle(name)}
    >
      <span aria-hidden="true">{selected ? '★' : '☆'}</span>
    </button>
  );
}

export type CatalogFilter = 'all' | 'active' | 'starred';

export function LocalContextCatalogFilter({
  value,
  onChange,
}: {
  value: CatalogFilter;
  onChange: (value: CatalogFilter) => void;
}) {
  const { kind, query } = useLocalContextSettings();
  return (
    <NativeSelect
      size="sm"
      aria-label={`Show ${kind}`}
      value={value}
      onChange={(event) => onChange(event.target.value as CatalogFilter)}
    >
      <option value="all">All</option>
      <option value="active" disabled={kind === 'tools' && !query.data}>
        Only active
      </option>
      <option value="starred" disabled={!query.data}>
        Only starred
      </option>
    </NativeSelect>
  );
}
