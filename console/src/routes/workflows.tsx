import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  deleteWorkflow,
  fetchWorkflows,
  toggleWorkflow,
} from '../api/client';
import type { AdminWorkflow } from '../api/types';
import { useAuth } from '../auth';
import {
  BooleanPill,
  MetricCard,
  PageHeader,
  Panel,
} from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';

function formatWorkflowTrigger(workflow: AdminWorkflow): string {
  const trigger = workflow.spec.trigger;
  if (trigger.kind === 'schedule') {
    if (trigger.runAt) return `at ${formatDateTime(trigger.runAt)}`;
    if (trigger.everyMs != null) return `every ${trigger.everyMs}ms`;
    if (trigger.cronExpr) return `cron ${trigger.cronExpr}`;
    return 'schedule';
  }
  if (trigger.kind === 'reaction') {
    return trigger.reactionEmoji
      ? `reaction ${trigger.reactionEmoji}`
      : 'reaction';
  }
  if (trigger.kind === 'keyword') {
    return trigger.contentPattern
      ? `keyword ${trigger.contentPattern}`
      : 'keyword';
  }
  return trigger.kind.replace(/_/g, ' ');
}

function formatWorkflowDelivery(workflow: AdminWorkflow): string {
  const delivery = workflow.spec.delivery;
  if (delivery.kind === 'originating') return 'originating channel';
  if (delivery.kind === 'channel') {
    return delivery.target ? `channel ${delivery.target}` : 'channel';
  }
  if (delivery.kind === 'email') {
    return delivery.target ? `email ${delivery.target}` : 'email';
  }
  return delivery.target ? `webhook ${delivery.target}` : 'webhook';
}

function replaceWorkflows(
  token: string,
  payload: { workflows: AdminWorkflow[] },
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  queryClient.setQueryData(['workflows', token], payload);
}

export function WorkflowsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  const workflowsQuery = useQuery({
    queryKey: ['workflows', auth.token],
    queryFn: () => fetchWorkflows(auth.token),
  });

  const toggleMutation = useMutation({
    mutationFn: (workflowId: number) => toggleWorkflow(auth.token, workflowId),
    onSuccess: (payload, workflowId) => {
      replaceWorkflows(auth.token, payload, queryClient);
      setSelectedId((current) => current ?? workflowId);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (workflowId: number) => deleteWorkflow(auth.token, workflowId),
    onSuccess: (payload, workflowId) => {
      replaceWorkflows(auth.token, payload, queryClient);
      setSelectedId((current) => (current === workflowId ? null : current));
    },
  });

  const filteredWorkflows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const workflows = workflowsQuery.data?.workflows || [];
    if (!needle) return workflows;
    return workflows.filter((workflow) =>
      [
        workflow.name,
        workflow.description,
        workflow.naturalLanguage,
        workflow.sessionId,
        workflow.agentId,
        workflow.channelId,
        workflow.spec.trigger.kind,
        workflow.spec.delivery.kind,
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [search, workflowsQuery.data?.workflows]);

  const selectedWorkflow =
    filteredWorkflows.find((workflow) => workflow.id === selectedId) ||
    filteredWorkflows[0] ||
    null;

  useEffect(() => {
    if (selectedWorkflow && selectedWorkflow.id !== selectedId) {
      setSelectedId(selectedWorkflow.id);
    }
  }, [selectedId, selectedWorkflow]);

  const enabledCount = filteredWorkflows.filter(
    (workflow) => workflow.enabled,
  ).length;
  const scheduledCount = filteredWorkflows.filter(
    (workflow) => workflow.spec.trigger.kind === 'schedule',
  ).length;
  const degradedCount = filteredWorkflows.filter(
    (workflow) => workflow.consecutiveErrors > 0,
  ).length;

  return (
    <div className="page-stack">
      <PageHeader
        title="Workflows"
        description="Inspect persisted workflows, toggle them, and remove stale automation."
        actions={
          <input
            className="compact-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by name, session, trigger"
          />
        }
      />

      <div className="metric-grid">
        <MetricCard
          label="Visible workflows"
          value={String(filteredWorkflows.length)}
          detail="after filtering"
        />
        <MetricCard
          label="Enabled"
          value={String(enabledCount)}
          detail="currently active"
        />
        <MetricCard
          label="Scheduled"
          value={String(scheduledCount)}
          detail="schedule-triggered"
        />
        <MetricCard
          label="Errors"
          value={String(degradedCount)}
          detail="with consecutive failures"
        />
      </div>

      <div className="two-column-grid sessions-layout">
        <Panel
          title="Workflow list"
          subtitle={`${filteredWorkflows.length} result${filteredWorkflows.length === 1 ? '' : 's'}`}
        >
          {workflowsQuery.isLoading ? (
            <div className="empty-state">Loading workflows...</div>
          ) : filteredWorkflows.length === 0 ? (
            <div className="empty-state">No workflows match this filter.</div>
          ) : (
            <div className="list-stack selectable-list">
              {filteredWorkflows.map((workflow) => (
                <button
                  key={workflow.id}
                  className={
                    workflow.id === selectedWorkflow?.id
                      ? 'selectable-row active'
                      : 'selectable-row'
                  }
                  type="button"
                  onClick={() => setSelectedId(workflow.id)}
                >
                  <div className="session-row-main">
                    <strong>
                      #{workflow.id} {workflow.name}
                    </strong>
                    <small className="session-row-meta">
                      {formatWorkflowTrigger(workflow)}
                      {' -> '}
                      {formatWorkflowDelivery(workflow)}
                    </small>
                  </div>
                  <span className="session-row-time">
                    {workflow.lastRun
                      ? formatRelativeTime(workflow.lastRun)
                      : 'never'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Inspection" accent="warm">
          {!selectedWorkflow ? (
            <div className="empty-state">Select a workflow to inspect it.</div>
          ) : (
            <div className="detail-stack">
              <div className="key-value-grid">
                <div>
                  <span>Workflow</span>
                  <strong>#{selectedWorkflow.id}</strong>
                </div>
                <div>
                  <span>State</span>
                  <BooleanPill
                    value={selectedWorkflow.enabled}
                    trueLabel="enabled"
                    falseLabel="disabled"
                  />
                </div>
                <div>
                  <span>Session</span>
                  <strong>{selectedWorkflow.sessionId}</strong>
                </div>
                <div>
                  <span>Agent</span>
                  <strong>{selectedWorkflow.agentId}</strong>
                </div>
                <div>
                  <span>Channel</span>
                  <strong>{selectedWorkflow.channelId}</strong>
                </div>
                <div>
                  <span>Companion task</span>
                  <strong>{selectedWorkflow.companionTaskId ?? 'none'}</strong>
                </div>
                <div>
                  <span>Trigger</span>
                  <strong>{formatWorkflowTrigger(selectedWorkflow)}</strong>
                </div>
                <div>
                  <span>Delivery</span>
                  <strong>{formatWorkflowDelivery(selectedWorkflow)}</strong>
                </div>
                <div>
                  <span>Steps</span>
                  <strong>
                    {selectedWorkflow.spec.steps
                      .map((step) => step.kind)
                      .join(' -> ')}
                  </strong>
                </div>
                <div>
                  <span>Run count</span>
                  <strong>{selectedWorkflow.runCount}</strong>
                </div>
                <div>
                  <span>Last run</span>
                  <strong>{formatDateTime(selectedWorkflow.lastRun)}</strong>
                </div>
                <div>
                  <span>Last status</span>
                  <strong>{selectedWorkflow.lastStatus || 'n/a'}</strong>
                </div>
                <div>
                  <span>Errors</span>
                  <strong>{selectedWorkflow.consecutiveErrors}</strong>
                </div>
                <div>
                  <span>Updated</span>
                  <strong>{formatDateTime(selectedWorkflow.updatedAt)}</strong>
                </div>
              </div>

              <label className="field">
                <span>Description</span>
                <textarea
                  readOnly
                  rows={3}
                  value={selectedWorkflow.description || 'No description.'}
                />
              </label>

              <label className="field">
                <span>Natural language</span>
                <textarea
                  readOnly
                  rows={4}
                  value={selectedWorkflow.naturalLanguage}
                />
              </label>

              <label className="field">
                <span>Compiled spec</span>
                <textarea
                  readOnly
                  rows={16}
                  value={JSON.stringify(selectedWorkflow.spec, null, 2)}
                />
              </label>

              <div className="button-row">
                <button
                  className="ghost-button"
                  type="button"
                  disabled={toggleMutation.isPending}
                  onClick={() => toggleMutation.mutate(selectedWorkflow.id)}
                >
                  {toggleMutation.isPending
                    ? 'Updating...'
                    : selectedWorkflow.enabled
                      ? 'Disable workflow'
                      : 'Enable workflow'}
                </button>
                <button
                  className="danger-button"
                  type="button"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    const confirmed = window.confirm(
                      `Delete workflow #${selectedWorkflow.id} (${selectedWorkflow.name})?`,
                    );
                    if (!confirmed) return;
                    deleteMutation.mutate(selectedWorkflow.id);
                  }}
                >
                  {deleteMutation.isPending
                    ? 'Deleting...'
                    : 'Delete workflow'}
                </button>
              </div>

              {toggleMutation.isError ? (
                <p className="error-banner">
                  {(toggleMutation.error as Error).message}
                </p>
              ) : null}
              {deleteMutation.isError ? (
                <p className="error-banner">
                  {(deleteMutation.error as Error).message}
                </p>
              ) : null}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
