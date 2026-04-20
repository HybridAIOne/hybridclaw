import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTools } from '../api/client';
import type { AdminToolCatalogEntry } from '../api/types';
import { useAuth } from '../auth';
import {
  MetricCard,
  PageHeader,
  Panel,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { compareDateTime, compareNumber, compareText } from '../lib/sort';

type ToolRow = AdminToolCatalogEntry & {
  groupLabel: string;
};

type ToolSortKey = 'tool' | 'group' | 'type' | 'invocations' | 'lastUsed';

const TOOL_SORTERS: Record<
  ToolSortKey,
  (left: ToolRow, right: ToolRow) => number
> = {
  tool: (left, right) => compareText(left.name, right.name),
  group: (left, right) =>
    compareText(left.groupLabel, right.groupLabel) ||
    compareText(left.name, right.name),
  type: (left, right) =>
    compareText(left.kind, right.kind) || compareText(left.name, right.name),
  invocations: (left, right) =>
    compareNumber(left.recentCalls, right.recentCalls) ||
    compareText(left.name, right.name),
  lastUsed: (left, right) =>
    compareDateTime(left.lastUsedAt, right.lastUsedAt) ||
    compareText(left.name, right.name),
};

const TOOL_DEFAULT_DIRECTIONS = {
  invocations: 'desc',
  lastUsed: 'desc',
} as const;

function ToolErrorPreview(props: {
  recentErrors: number;
  samples: Array<{
    id: number;
    sessionId: string;
    timestamp: string;
    summary: string;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function handlePointerDown(event: MouseEvent) {
      const node = detailsRef.current;
      if (node && !node.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [open]);

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
    <details
      ref={detailsRef}
      className="inline-popover"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
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

  const toolsQuery = useQuery({
    queryKey: ['tools', auth.token],
    queryFn: () => fetchTools(auth.token),
  });

  const filteredTools = useMemo(() => {
    const needle = deferredFilter.trim().toLowerCase();
    const groups = toolsQuery.data?.groups || [];
    return groups.flatMap((group) =>
      group.tools
        .filter((tool) =>
          [tool.name, tool.group, tool.kind]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        )
        .map((tool) => ({
          ...tool,
          groupLabel: group.label,
        })),
    );
  }, [deferredFilter, toolsQuery.data?.groups]);

  const {
    sortedRows: sortedTools,
    sortState,
    toggleSort,
  } = useSortableRows<ToolRow, ToolSortKey>(filteredTools, {
    initialSort: {
      key: 'invocations',
      direction: 'desc',
    },
    sorters: TOOL_SORTERS,
    defaultDirections: TOOL_DEFAULT_DIRECTIONS,
  });

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
        <Panel title="Catalog">
          {toolsQuery.isLoading ? (
            <div className="empty-state">Loading tool catalog...</div>
          ) : sortedTools.length === 0 ? (
            <div className="empty-state">No tools match this filter.</div>
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <SortableHeader
                      label="Tool"
                      sortKey="tool"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Group"
                      sortKey="group"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Type"
                      sortKey="type"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Invocations"
                      sortKey="invocations"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Last used"
                      sortKey="lastUsed"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortedTools.map((tool) => (
                    <tr key={tool.name}>
                      <td>
                        <strong>{tool.name}</strong>
                        <ToolErrorPreview
                          recentErrors={tool.recentErrors}
                          samples={tool.recentErrorSamples}
                        />
                      </td>
                      <td>{tool.groupLabel}</td>
                      <td>{tool.kind}</td>
                      <td>{tool.recentCalls}</td>
                      <td>{formatDateTime(tool.lastUsedAt)}</td>
                    </tr>
                  ))}
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
