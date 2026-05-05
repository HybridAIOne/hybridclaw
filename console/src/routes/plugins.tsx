import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { fetchPlugins } from '../api/client';
import type { AdminPlugin } from '../api/types';
import { useAuth } from '../auth';
import {
  BooleanPill,
  MetricCard,
  PageHeader,
  Panel,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
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

export function PluginsPage() {
  const auth = useAuth();
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const filterNeedle = deferredFilter.trim().toLowerCase();

  const pluginsQuery = useQuery({
    queryKey: ['plugins', auth.token],
    queryFn: () => fetchPlugins(auth.token),
  });

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

  return (
    <div className="page-stack">
      <PageHeader
        title="Plugins"
        description="Discovery and runtime load status for configured HybridClaw plugins."
        actions={
          <input
            className="compact-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter plugins"
          />
        }
      />

      <div className="metric-grid">
        <MetricCard
          label="Plugins"
          value={String(pluginsQuery.data?.totals.totalPlugins || 0)}
          detail={`${pluginsQuery.data?.totals.enabledPlugins || 0} enabled`}
        />
        <MetricCard
          label="Load failures"
          value={String(pluginsQuery.data?.totals.failedPlugins || 0)}
          detail="runtime initialization errors"
        />
        <MetricCard
          label="Commands"
          value={String(pluginsQuery.data?.totals.commands || 0)}
          detail="plugin-defined commands"
        />
        <MetricCard
          label="Tools / Hooks"
          value={`${pluginsQuery.data?.totals.tools || 0} / ${pluginsQuery.data?.totals.hooks || 0}`}
          detail="registered runtime surfaces"
        />
      </div>

      <div className="two-column-grid">
        <Panel
          title="Registry"
          subtitle={`${plugins.length} plugin${plugins.length === 1 ? '' : 's'} visible`}
        >
          {pluginsQuery.isLoading ? (
            <div className="empty-state">Loading plugins...</div>
          ) : pluginsQuery.data?.plugins.length === 0 ? (
            <div className="empty-state-cta">
              <p>
                Plugins extend HybridClaw with custom commands, tools, and
                hooks.
              </p>
              <a
                className="ghost-button"
                href="https://www.hybridclaw.io/docs/extensibility/plugins"
                target="_blank"
                rel="noreferrer"
              >
                Plugin documentation
              </a>
            </div>
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
        </Panel>

        <Panel title="Failures" accent="warm">
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
        </Panel>
      </div>
    </div>
  );
}
