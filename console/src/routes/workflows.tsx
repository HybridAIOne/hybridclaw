import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  approveWorkflow,
  fetchWorkflows,
  returnWorkflow,
  startWorkflow,
} from '../api/client';
import type { AdminWorkflowRun } from '../api/types';
import { useAuth } from '../auth';
import { MetricCard, PageHeader, Panel } from '../components/ui';
import { formatRelativeTime } from '../lib/format';

function WorkflowRunTimeline(props: { run: AdminWorkflowRun }) {
  return (
    <ol className="timeline-list">
      {props.run.steps.map((step) => (
        <li
          className={`timeline-item ${props.run.current_step_id === step.step_id ? 'active' : ''}`}
          key={step.step_id}
        >
          <div>
            <strong>{step.step_id}</strong>
            <small>{step.owner_coworker_id}</small>
          </div>
          <span className="status-pill">{step.status}</span>
          <p>{step.action}</p>
          {step.escalation?.route === 'approval_request' &&
          !step.escalation.approved_at ? (
            <small>
              pending approval - stakes {step.escalation.stakes} / threshold{' '}
              {step.escalation.threshold}
            </small>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function WorkflowsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState('');
  const [revisionNotes, setRevisionNotes] = useState('');

  const workflowsQuery = useQuery({
    queryKey: ['admin-workflows', auth.token],
    queryFn: () => fetchWorkflows(auth.token),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['admin-workflows', auth.token],
    });
  };

  const startMutation = useMutation({
    mutationFn: (workflowId: string) => startWorkflow(auth.token, workflowId),
    onSuccess: async (result) => {
      setSelectedRunId(result.run.id);
      await invalidate();
    },
  });

  const approveMutation = useMutation({
    mutationFn: (run: AdminWorkflowRun) =>
      approveWorkflow(auth.token, run.id, run.current_step_id),
    onSuccess: async (result) => {
      setSelectedRunId(result.run.id);
      await invalidate();
    },
  });

  const returnMutation = useMutation({
    mutationFn: (run: AdminWorkflowRun) => {
      const stepId = run.current_step_id || run.steps[0]?.step_id || '';
      return returnWorkflow(auth.token, run.id, stepId, revisionNotes.trim());
    },
    onSuccess: async (result) => {
      setSelectedRunId(result.run.id);
      setRevisionNotes('');
      await invalidate();
    },
  });

  const runs = workflowsQuery.data?.runs || [];
  const selectedRun = useMemo(
    () =>
      runs.find((run) => run.id === selectedRunId) ||
      runs[0] ||
      null,
    [runs, selectedRunId],
  );
  const activeRuns = runs.filter((run) => run.status !== 'completed').length;
  const pendingRuns = runs.filter((run) => run.status === 'paused').length;

  return (
    <div className="page-stack">
      <PageHeader title="Workflows" />

      <div className="metric-grid">
        <MetricCard
          label="Definitions"
          value={String(workflowsQuery.data?.definitions.length || 0)}
          detail="loaded templates"
        />
        <MetricCard
          label="Runs"
          value={String(runs.length)}
          detail="persisted workflow state"
        />
        <MetricCard
          label="Active"
          value={String(activeRuns)}
          detail="running or paused"
        />
        <MetricCard
          label="Pending"
          value={String(pendingRuns)}
          detail="approval required"
        />
      </div>

      <div className="two-column-grid">
        <Panel title="Definitions">
          {workflowsQuery.isLoading ? (
            <div className="empty-state">Loading workflows...</div>
          ) : workflowsQuery.data?.definitions.length ? (
            <div className="stack-list">
              {workflowsQuery.data.definitions.map((definition) => (
                <div className="list-row" key={definition.id}>
                  <div>
                    <strong>{definition.name}</strong>
                    <small>
                      {definition.id} - {definition.steps.length} steps
                    </small>
                  </div>
                  <button
                    className="primary-button"
                    disabled={startMutation.isPending}
                    onClick={() => startMutation.mutate(definition.id)}
                    type="button"
                  >
                    Start
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No workflow definitions loaded.</div>
          )}
        </Panel>

        <Panel title="Runs">
          {runs.length ? (
            <div className="stack-list">
              {runs.map((run) => (
                <button
                  className="list-row button-row"
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id)}
                  type="button"
                >
                  <div>
                    <strong>{run.workflow.name}</strong>
                    <small>
                      {run.id} - {formatRelativeTime(run.updated_at)}
                    </small>
                  </div>
                  <span className="status-pill">{run.status}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">No workflow runs yet.</div>
          )}
        </Panel>
      </div>

      <Panel title="Run state">
        {selectedRun ? (
          <div className="page-stack">
            <div className="list-row">
              <div>
                <strong>{selectedRun.workflow.name}</strong>
                <small>
                  {selectedRun.id}
                  {selectedRun.current_step_id
                    ? ` - active: ${selectedRun.current_step_id}`
                    : ''}
                </small>
              </div>
              <span className="status-pill">{selectedRun.status}</span>
            </div>
            <WorkflowRunTimeline run={selectedRun} />
            <div className="inline-actions">
              <button
                className="primary-button"
                disabled={
                  selectedRun.status !== 'paused' || approveMutation.isPending
                }
                onClick={() => approveMutation.mutate(selectedRun)}
                type="button"
              >
                Approve
              </button>
              <input
                className="compact-search"
                onChange={(event) => setRevisionNotes(event.target.value)}
                placeholder="Revision notes"
                value={revisionNotes}
              />
              <button
                disabled={!revisionNotes.trim() || returnMutation.isPending}
                onClick={() => returnMutation.mutate(selectedRun)}
                type="button"
              >
                Return
              </button>
            </div>
          </div>
        ) : (
          <div className="empty-state">Select or start a workflow run.</div>
        )}
      </Panel>
    </div>
  );
}
