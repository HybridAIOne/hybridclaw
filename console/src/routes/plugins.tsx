/**
 * Plugin operations surface — the console view of the gateway's live registry.
 *
 * Installs are explicit operator actions and refresh this registry after the
 * gateway reloads; discovery and dependency policy remain gateway concerns.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useDeferredValue, useState } from 'react';
import {
  fetchPlugins,
  installOfficialPlugin,
  installPlugin,
} from '../api/client';
import type { AdminPlugin } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Input } from '../components/input';
import { TabbedPageActions } from '../components/tabbed-page';
import { useToast } from '../components/toast';
import {
  BooleanPill,
  MetricCard,
  PageHeader,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { compareBoolean, compareNumber, compareText } from '../lib/sort';

type PluginSortKey =
  | 'plugin'
  | 'source'
  | 'enabled'
  | 'status'
  | 'commands'
  | 'tools'
  | 'hooks';

const PLUGIN_SORTERS: Record<
  PluginSortKey,
  (left: AdminPlugin, right: AdminPlugin) => number
> = {
  plugin: (left, right) =>
    compareText(left.name || left.id, right.name || right.id) ||
    compareText(left.id, right.id),
  source: (left, right) =>
    compareText(left.source, right.source) ||
    compareText(left.name || left.id, right.name || right.id),
  enabled: (left, right) =>
    compareBoolean(left.enabled, right.enabled) ||
    compareText(left.name || left.id, right.name || right.id),
  status: (left, right) =>
    compareBoolean(left.status === 'loaded', right.status === 'loaded') ||
    compareText(left.name || left.id, right.name || right.id),
  commands: (left, right) =>
    compareNumber(left.commands.length, right.commands.length) ||
    compareText(left.name || left.id, right.name || right.id),
  tools: (left, right) =>
    compareNumber(left.tools.length, right.tools.length) ||
    compareText(left.name || left.id, right.name || right.id),
  hooks: (left, right) =>
    compareNumber(left.hooks.length, right.hooks.length) ||
    compareText(left.name || left.id, right.name || right.id),
};

const PLUGIN_DEFAULT_DIRECTIONS = {
  enabled: 'desc',
  status: 'desc',
  commands: 'desc',
  tools: 'desc',
  hooks: 'desc',
} as const;

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function matchesPluginFilter(plugin: AdminPlugin, needle: string): boolean {
  if (!needle) return true;
  return [
    plugin.id,
    plugin.name || '',
    plugin.description || '',
    plugin.source,
    plugin.status,
    plugin.error || '',
    ...plugin.commands,
    ...plugin.tools,
    ...plugin.hooks,
  ]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export function PluginsPage(props: { embedded?: boolean } = {}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [installSource, setInstallSource] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const filterNeedle = deferredFilter.trim().toLowerCase();

  const pluginsQuery = useQuery({
    queryKey: ['plugins', auth.token],
    queryFn: () => fetchPlugins(auth.token),
  });

  const officialInstallMutation = useMutation({
    mutationFn: async (pluginId: string) => {
      const result = await installOfficialPlugin(auth.token, pluginId);
      if (result.kind === 'error') throw new Error(result.text);
      return result;
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: ['plugins', auth.token],
      });
      toast.success(
        result.title || 'Plugin installed',
        'The gateway reloaded the plugin runtime and refreshed the registry.',
      );
    },
    onError: (error) => {
      toast.error('Plugin installation failed', getErrorMessage(error));
    },
  });

  const sourceInstallMutation = useMutation({
    mutationFn: async (source: string) => {
      const result = await installPlugin(auth.token, source);
      if (result.kind === 'error') throw new Error(result.text);
      return result;
    },
    onSuccess: async (result) => {
      setInstallSource('');
      await queryClient.invalidateQueries({
        queryKey: ['plugins', auth.token],
      });
      toast.success(
        result.title || 'Plugin installed',
        'The gateway reloaded the plugin runtime and refreshed the registry.',
      );
    },
    onError: (error) => {
      toast.error('Plugin installation failed', getErrorMessage(error));
    },
  });

  function handleSourceInstall(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const source = installSource.trim();
    if (source) sourceInstallMutation.mutate(source);
  }

  const isInstalling =
    officialInstallMutation.isPending || sourceInstallMutation.isPending;

  const filteredPlugins = (pluginsQuery.data?.plugins || []).filter((plugin) =>
    matchesPluginFilter(plugin, filterNeedle),
  );
  const {
    sortedRows: plugins,
    sortState,
    toggleSort,
  } = useSortableRows<AdminPlugin, PluginSortKey>(filteredPlugins, {
    initialSort: {
      key: 'plugin',
      direction: 'asc',
    },
    sorters: PLUGIN_SORTERS,
    defaultDirections: PLUGIN_DEFAULT_DIRECTIONS,
  });
  const failedPlugins = plugins.filter((plugin) => plugin.status === 'failed');
  const filterInput = (
    <Input
      size="sm"
      className={
        props.embedded ? 'compact-search page-tab-search' : 'compact-search'
      }
      value={filter}
      onChange={(event) => setFilter(event.target.value)}
      placeholder="Filter plugins"
      aria-label="Filter plugins"
    />
  );

  return (
    <div className="page-stack">
      {props.embedded ? (
        <TabbedPageActions>{filterInput}</TabbedPageActions>
      ) : null}
      <PageHeader actions={props.embedded ? undefined : filterInput} />

      <Card variant="muted" className="plugin-install-card">
        <CardHeader>
          <CardTitle>Official plugins</CardTitle>
          <CardDescription>
            One-click installs from the HybridClaw curated catalog.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pluginsQuery.isLoading ? (
            <div className="empty-state">Loading official plugins...</div>
          ) : pluginsQuery.data?.availableOfficialPlugins.length ? (
            <div className="list-stack selectable-list">
              {pluginsQuery.data.availableOfficialPlugins.map((plugin) => {
                const label = plugin.name || plugin.id;
                const isInstallingOfficialPlugin =
                  officialInstallMutation.isPending &&
                  officialInstallMutation.variables === plugin.id;
                return (
                  <div className="list-row" key={plugin.id}>
                    <div>
                      <strong>{label}</strong>
                      <small>
                        {plugin.id}
                        {plugin.version ? ` · v${plugin.version}` : ''}
                      </small>
                      {plugin.description ? (
                        <small>{plugin.description}</small>
                      ) : null}
                    </div>
                    <div className="plugin-catalog-action">
                      <span className="list-status">
                        Official · {plugin.source}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        loading={isInstallingOfficialPlugin}
                        disabled={isInstalling}
                        onClick={() =>
                          officialInstallMutation.mutate(plugin.id)
                        }
                      >
                        {isInstallingOfficialPlugin
                          ? 'Installing...'
                          : `Install ${label}`}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              Every available official plugin is already installed.
            </div>
          )}
        </CardContent>
      </Card>

      <Card variant="muted" className="plugin-install-card">
        <CardHeader>
          <CardTitle>Install from a source</CardTitle>
          <CardDescription>
            Install any compatible plugin by ID, npm package, local path, or
            archive URL. The gateway installs declared dependencies and reloads
            the runtime.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="plugin-install-form" onSubmit={handleSourceInstall}>
            <Input
              value={installSource}
              onChange={(event) => setInstallSource(event.target.value)}
              placeholder="Plugin ID, package, path, or archive URL"
              aria-label="Plugin source"
              autoComplete="off"
              spellCheck={false}
              disabled={isInstalling}
            />
            <Button
              type="submit"
              loading={sourceInstallMutation.isPending}
              disabled={isInstalling || !installSource.trim()}
            >
              {sourceInstallMutation.isPending
                ? 'Installing...'
                : 'Install plugin'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="metric-grid">
        <MetricCard
          label="Plugins"
          value={String(pluginsQuery.data?.totals.totalPlugins ?? 0)}
          detail={`${pluginsQuery.data?.totals.enabledPlugins ?? 0} enabled`}
          loading={!pluginsQuery.data}
        />
        <MetricCard
          label="Load failures"
          value={String(pluginsQuery.data?.totals.failedPlugins ?? 0)}
          detail="runtime initialization errors"
          loading={!pluginsQuery.data}
        />
        <MetricCard
          label="Commands"
          value={String(pluginsQuery.data?.totals.commands ?? 0)}
          detail="plugin-defined commands"
          loading={!pluginsQuery.data}
        />
        <MetricCard
          label="Tools / Hooks"
          value={`${pluginsQuery.data?.totals.tools ?? 0} / ${pluginsQuery.data?.totals.hooks ?? 0}`}
          detail="registered runtime surfaces"
          loading={!pluginsQuery.data}
        />
      </div>

      <div className="two-column-grid">
        <Card>
          <CardHeader>
            <CardTitle>Registry</CardTitle>
            <CardDescription>
              {`${plugins.length} plugin${plugins.length === 1 ? '' : 's'} visible`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {pluginsQuery.isLoading ? (
              <div className="empty-state">Loading plugins...</div>
            ) : plugins.length === 0 ? (
              <div className="empty-state">No plugins match this filter.</div>
            ) : (
              <div className="table-shell">
                <table>
                  <thead>
                    <tr>
                      <SortableHeader
                        label="Plugin"
                        sortKey="plugin"
                        sortState={sortState}
                        onToggle={toggleSort}
                      />
                      <SortableHeader
                        label="Source"
                        sortKey="source"
                        sortState={sortState}
                        onToggle={toggleSort}
                      />
                      <SortableHeader
                        label="Enabled"
                        sortKey="enabled"
                        sortState={sortState}
                        onToggle={toggleSort}
                      />
                      <SortableHeader
                        label="Status"
                        sortKey="status"
                        sortState={sortState}
                        onToggle={toggleSort}
                      />
                      <SortableHeader
                        label="Commands"
                        sortKey="commands"
                        sortState={sortState}
                        onToggle={toggleSort}
                      />
                      <SortableHeader
                        label="Tools"
                        sortKey="tools"
                        sortState={sortState}
                        onToggle={toggleSort}
                      />
                      <SortableHeader
                        label="Hooks"
                        sortKey="hooks"
                        sortState={sortState}
                        onToggle={toggleSort}
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {plugins.map((plugin) => (
                      <tr key={plugin.id}>
                        <td>
                          <strong>{plugin.name || plugin.id}</strong>
                          <small>
                            {plugin.id}
                            {plugin.version ? ` · v${plugin.version}` : ''}
                          </small>
                          {plugin.description ? (
                            <small>{plugin.description}</small>
                          ) : null}
                          {plugin.error ? <small>{plugin.error}</small> : null}
                        </td>
                        <td>{plugin.source}</td>
                        <td>
                          <BooleanPill
                            value={plugin.enabled}
                            trueLabel="enabled"
                            falseLabel="disabled"
                          />
                        </td>
                        <td>
                          <BooleanPill
                            value={plugin.status === 'loaded'}
                            trueLabel="loaded"
                            falseLabel="failed"
                          />
                        </td>
                        <td>
                          <strong>{plugin.commands.length}</strong>
                          <small>{formatList(plugin.commands)}</small>
                        </td>
                        <td>
                          <strong>{plugin.tools.length}</strong>
                          <small>{formatList(plugin.tools)}</small>
                        </td>
                        <td>
                          <strong>{plugin.hooks.length}</strong>
                          <small>{formatList(plugin.hooks)}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <CardTitle>Failures</CardTitle>
          </CardHeader>
          <CardContent>
            {pluginsQuery.isLoading ? (
              <div className="empty-state">Loading plugin status...</div>
            ) : failedPlugins.length > 0 ? (
              <div className="list-stack selectable-list">
                {failedPlugins.map((plugin) => (
                  <div className="list-row" key={plugin.id}>
                    <div>
                      <strong>{plugin.name || plugin.id}</strong>
                      <small>
                        {plugin.id}
                        {plugin.version ? ` · v${plugin.version}` : ''}
                      </small>
                      <small>
                        {plugin.error || 'Unknown plugin load error.'}
                      </small>
                    </div>
                    <span className="list-status list-status-danger">
                      <span className="status-dot status-dot-danger" />
                      failed
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                No plugin load failures were reported.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
