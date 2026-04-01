import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useMemo, useState } from 'react';
import { useAuth } from '../auth';
import { MetricCard, PageHeader, Panel } from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { toolsQueryOptions } from '../queries';

function ToolErrorPreview(props: {
  recentErrors: number;
  samples: Array<{
    id: number;
    sessionId: string;
    timestamp: string;
    summary: string;
  }>;
}) {
  if (props.recentErrors === 0) {
    return <small>no recent errors</small>;
  }

  if (props.samples.length === 0) {
    return (
      <small>
        {props.recentErrors} recent error{props.recentErrors === 1 ? '' : 's'}
      </small>
    );
  }

  const hoverTitle = props.samples
    .map((sample) => `${sample.sessionId}: ${sample.summary}`)
    .join('\n\n');

  return (
    <details className="inline-popover">
      <summary className="inline-popover-trigger" title={hoverTitle}>
        {props.recentErrors} recent error{props.recentErrors === 1 ? '' : 's'}
      </summary>
      <div className="inline-popover-panel">
        <div className="inline-popover-header">Recent errors</div>
        <div className="inline-popover-list">
          {props.samples.map((sample) => (
            <div className="inline-popover-entry" key={sample.id}>
              <strong>{formatRelativeTime(sample.timestamp)}</strong>
              <small>{sample.sessionId}</small>
              <p>{sample.summary}</p>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function ToolsPage() {
  const auth = useAuth();
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);

  const toolsQuery = useQuery(toolsQueryOptions(auth.token));

  const filteredGroups = useMemo(() => {
    const needle = deferredFilter.trim().toLowerCase();
    const groups = toolsQuery.data?.groups || [];
    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        tools: group.tools.filter((tool) =>
          [tool.name, tool.group, tool.kind]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        ),
      }))
      .filter((group) => group.tools.length > 0);
  }, [deferredFilter, toolsQuery.data?.groups]);

  const filteredToolCount = filteredGroups.reduce(
    (sum, group) => sum + group.tools.length,
    0,
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="Tools"
        actions={
          <input
            className="compact-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter tools"
          />
        }
      />

      <div className="metric-grid">
        <MetricCard
          label="Catalog tools"
          value={String(toolsQuery.data?.totals.totalTools || 0)}
          detail={`${toolsQuery.data?.totals.builtinTools || 0} built-in`}
        />
        <MetricCard
          label="MCP tools seen"
          value={String(toolsQuery.data?.totals.mcpTools || 0)}
          detail="from recent audit traffic"
        />
        <MetricCard
          label="Recent executions"
          value={String(toolsQuery.data?.totals.recentExecutions || 0)}
          detail="last 200 tool results"
        />
        <MetricCard
          label="Recent errors"
          value={String(toolsQuery.data?.totals.recentErrors || 0)}
          detail="tool.result failures"
        />
      </div>

      <div className="two-column-grid">
        <Panel
          title="Catalog"
          subtitle={`${filteredToolCount} tool${filteredToolCount === 1 ? '' : 's'} visible`}
        >
          {toolsQuery.isLoading ? (
            <div className="empty-state">Loading tool catalog...</div>
          ) : filteredToolCount === 0 ? (
            <div className="empty-state">No tools match this filter.</div>
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Group</th>
                    <th>Type</th>
                    <th>Recent</th>
                    <th>Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGroups.flatMap((group) =>
                    group.tools.map((tool) => (
                      <tr key={tool.name}>
                        <td>
                          <strong>{tool.name}</strong>
                          <ToolErrorPreview
                            recentErrors={tool.recentErrors}
                            samples={tool.recentErrorSamples}
                          />
                        </td>
                        <td>{group.label}</td>
                        <td>{tool.kind}</td>
                        <td>{tool.recentCalls}</td>
                        <td>{formatDateTime(tool.lastUsedAt)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Recent executions" accent="warm">
          {toolsQuery.isLoading ? (
            <div className="empty-state">Loading recent executions...</div>
          ) : toolsQuery.data?.recentExecutions.length ? (
            <div className="list-stack selectable-list">
              {toolsQuery.data.recentExecutions.map((execution) => (
                <div className="list-row" key={execution.id}>
                  <div>
                    <strong>{execution.toolName}</strong>
                    <small>
                      {execution.sessionId} ·{' '}
                      {formatRelativeTime(execution.timestamp)}
                      {execution.durationMs == null
                        ? ''
                        : ` · ${execution.durationMs}ms`}
                    </small>
                    {execution.isError && execution.summary ? (
                      <small>{execution.summary}</small>
                    ) : null}
                  </div>
                  <span
                    className={
                      execution.isError
                        ? 'list-status list-status-danger'
                        : 'list-status list-status-success'
                    }
                  >
                    <span
                      className={
                        execution.isError
                          ? 'status-dot status-dot-danger'
                          : 'status-dot status-dot-success'
                      }
                    />
                    {execution.isError ? 'error' : 'ok'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              No recent tool executions were found in structured audit events.
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
