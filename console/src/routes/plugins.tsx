import { useDeferredValue, useState } from 'react';
import type { AdminPlugin } from '../api/types';
import { BooleanPill, MetricCard, PageHeader, Panel } from '../components/ui';
import { useAdminQuery } from '../hooks/use-admin';
import { pluginsQueryOptions } from '../queries';

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
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const filterNeedle = deferredFilter.trim().toLowerCase();

  const pluginsQuery = useAdminQuery(pluginsQueryOptions);

  const plugins = (pluginsQuery.data?.plugins || []).filter((plugin) =>
    matchesPluginFilter(plugin, filterNeedle),
  );
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
          ) : plugins.length === 0 ? (
            <div className="empty-state">No plugins match this filter.</div>
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Plugin</th>
                    <th>Source</th>
                    <th>Enabled</th>
                    <th>Status</th>
                    <th>Commands</th>
                    <th>Tools</th>
                    <th>Hooks</th>
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
