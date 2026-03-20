import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import {
  createJob,
  fetchJobHistory,
  fetchJobs,
  moveJob,
  updateJob,
} from '../api/client';
import type { AdminJob, AdminJobsResponse } from '../api/types';
import { useAuth } from '../auth';
import { PageHeader, Panel } from '../components/ui';
import { useLiveEvents } from '../hooks/use-live-events';
import { formatDateTime, formatRelativeTime } from '../lib/format';

const JOB_STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'done',
] as const satisfies ReadonlyArray<AdminJob['status']>;

type JobStatus = (typeof JOB_STATUSES)[number];

interface JobDraft {
  title: string;
  details: string;
  status: JobStatus;
  priority: AdminJob['priority'];
  assigneeAgentId: string;
  sourceSessionId: string;
  linkedTaskId: string;
}

function createDraft(job?: AdminJob | null): JobDraft {
  return {
    title: job?.title || '',
    details: job?.details || '',
    status: job?.status || 'backlog',
    priority: job?.priority || 'normal',
    assigneeAgentId: job?.assigneeAgentId || '',
    sourceSessionId: job?.sourceSessionId || '',
    linkedTaskId:
      typeof job?.linkedTaskId === 'number' ? String(job.linkedTaskId) : '',
  };
}

function replaceJobs(
  payload: AdminJobsResponse,
  token: string,
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  queryClient.setQueryData(['jobs', token], payload);
}

function statusLabel(status: JobStatus): string {
  return status === 'in_progress' ? 'in progress' : status;
}

function formatEventAction(action: string): string {
  switch (action) {
    case 'dispatch_started':
      return 'dispatch started';
    case 'dispatch_failed':
      return 'dispatch failed';
    case 'dispatch_succeeded':
      return 'dispatch succeeded';
    case 'dispatch_exhausted':
      return 'dispatch exhausted';
    default:
      return action;
  }
}

function summarizeEventPayload(action: string, payloadJson: string): string {
  const normalized = payloadJson.trim();
  if (!normalized || normalized === '{}' || normalized === 'null') {
    return 'No extra details.';
  }
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    if (action === 'dispatch_started') {
      return `Attempt ${parsed.attempt || 1}`;
    }
    if (action === 'dispatch_succeeded') {
      return `Completed on attempt ${parsed.attempt || 1}`;
    }
    if (action === 'dispatch_failed') {
      const attempt = parsed.attempt || 1;
      const error = String(parsed.error || '').trim();
      return error
        ? `Attempt ${attempt}: ${error}`
        : `Attempt ${attempt} failed`;
    }
    if (action === 'dispatch_exhausted') {
      return `Retries exhausted (${parsed.maxAttempts || parsed.attempt || 3})`;
    }
    if (parsed.fromStatus && parsed.toStatus) {
      return `${parsed.fromStatus} -> ${parsed.toStatus}`;
    }
    const keys = Object.keys(parsed);
    if (keys.length === 0) return 'No extra details.';
    return keys.join(', ');
  } catch {
    return normalized;
  }
}

export function JobsPage() {
  const auth = useAuth();
  const live = useLiveEvents(auth.token);
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<JobDraft>(createDraft());
  const deferredSearch = useDeferredValue(search);

  const jobsQuery = useQuery({
    queryKey: ['jobs', auth.token],
    queryFn: () => fetchJobs(auth.token),
  });

  const jobsData = live.jobs || jobsQuery.data;
  const allJobs = jobsData?.jobs || [];
  const filteredJobs = allJobs.filter((job) => {
    const haystack = [
      job.title,
      job.details,
      job.status,
      job.priority,
      job.assigneeAgentId || '',
      job.sourceSessionId || '',
      job.dispatch?.label || '',
      job.dispatch?.summary || '',
      String(job.id),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(deferredSearch.trim().toLowerCase());
  });
  const selectedJob = allJobs.find((job) => job.id === selectedId) || null;

  const historyQuery = useQuery({
    queryKey: ['job-history', auth.token, selectedJob?.id || 0],
    queryFn: () => fetchJobHistory(auth.token, selectedJob?.id || 0),
    enabled: Boolean(selectedJob),
  });

  useEffect(() => {
    if (!selectedId) {
      setDraft(createDraft());
      return;
    }
    if (!selectedJob) {
      setSelectedId(null);
      setDraft(createDraft());
      return;
    }
    setDraft(createDraft(selectedJob));
  }, [selectedId, selectedJob]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (selectedJob) {
        let payload: AdminJobsResponse | null = null;
        if (draft.status !== selectedJob.status) {
          payload = await moveJob(auth.token, {
            jobId: selectedJob.id,
            status: draft.status,
          });
        }
        const patch: Parameters<typeof updateJob>[2] = {};
        if (draft.title.trim() !== selectedJob.title) patch.title = draft.title;
        if (draft.details.trim() !== selectedJob.details) {
          patch.details = draft.details;
        }
        if (draft.priority !== selectedJob.priority) {
          patch.priority = draft.priority;
        }
        if (
          (draft.assigneeAgentId.trim() || null) !== selectedJob.assigneeAgentId
        ) {
          patch.assigneeAgentId = draft.assigneeAgentId.trim() || null;
        }
        if (
          (draft.sourceSessionId.trim() || null) !== selectedJob.sourceSessionId
        ) {
          patch.sourceSessionId = draft.sourceSessionId.trim() || null;
        }
        const linkedTaskId =
          Number.parseInt(draft.linkedTaskId.trim(), 10) || null;
        if (linkedTaskId !== selectedJob.linkedTaskId) {
          patch.linkedTaskId = linkedTaskId;
        }
        if (Object.keys(patch).length > 0) {
          payload = await updateJob(auth.token, selectedJob.id, patch);
        }
        return {
          payload: payload || (await fetchJobs(auth.token)),
          selectedId: selectedJob.id,
        };
      }

      const payload = await createJob(auth.token, {
        title: draft.title.trim(),
        details: draft.details.trim(),
        status: draft.status,
        priority: draft.priority,
        assigneeAgentId: draft.assigneeAgentId.trim() || null,
        sourceSessionId: draft.sourceSessionId.trim() || null,
        linkedTaskId: Number.parseInt(draft.linkedTaskId.trim(), 10) || null,
      });
      const createdId = payload.jobs.reduce(
        (max, job) => Math.max(max, job.id),
        0,
      );
      return { payload, selectedId: createdId };
    },
    onSuccess: ({ payload, selectedId: nextSelectedId }) => {
      replaceJobs(payload, auth.token, queryClient);
      setSelectedId(nextSelectedId || null);
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) => {
      if (!selectedJob) {
        throw new Error('Select a job first.');
      }
      return updateJob(auth.token, selectedJob.id, { archived });
    },
    onSuccess: (payload) => {
      replaceJobs(payload, auth.token, queryClient);
      setSelectedId(null);
      setDraft(createDraft());
    },
  });

  if (jobsQuery.isLoading && !jobsData) {
    return <div className="empty-state">Loading jobs...</div>;
  }

  if (jobsQuery.isError && !jobsData) {
    return (
      <div className="empty-state error">
        {(jobsQuery.error as Error).message}
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Jobs"
        description="Persistent board for user and agent work items."
        actions={
          <div className="jobs-toolbar">
            <input
              className="compact-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter jobs"
            />
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
                setSelectedId(null);
                setDraft(createDraft());
              }}
            >
              New job
            </button>
          </div>
        }
      />

      <div className="jobs-board">
        {(jobsData?.columns || []).map((column) => {
          const laneJobs = filteredJobs.filter(
            (job) => job.status === column.id,
          );
          return (
            <section
              className="jobs-lane"
              data-status={column.id}
              key={column.id}
            >
              <div className="jobs-lane-header">
                <div>
                  <h4>{column.label}</h4>
                  <small>{column.count} items</small>
                </div>
                <span className="meta-chip">{statusLabel(column.id)}</span>
              </div>
              <div className="jobs-lane-stack">
                {laneJobs.length === 0 ? (
                  <div className="jobs-lane-empty">No matching jobs.</div>
                ) : (
                  laneJobs.map((job) => (
                    <button
                      key={job.id}
                      className={
                        job.id === selectedId ? 'job-card active' : 'job-card'
                      }
                      data-status={job.status}
                      type="button"
                      onClick={() => setSelectedId(job.id)}
                    >
                      <div className="job-card-topline">
                        <span
                          className={`job-presence job-presence-${job.dispatch?.phase || 'planning'}`}
                        >
                          {job.dispatch?.label || statusLabel(job.status)}
                        </span>
                        <span
                          className={`job-priority job-priority-${job.priority}`}
                        >
                          {job.priority}
                        </span>
                      </div>
                      <div className="job-card-header">
                        <strong className="job-card-title">{job.title}</strong>
                      </div>
                      {job.details ? (
                        <p className="job-card-body">{job.details}</p>
                      ) : null}
                      <div className="job-card-meta">
                        <span>
                          {job.dispatch?.summary ||
                            job.assigneeAgentId ||
                            'unassigned'}
                        </span>
                        <span>{formatRelativeTime(job.updatedAt)}</span>
                      </div>
                      <div className="job-card-meta">
                        <span>#{job.id}</span>
                        <span>{job.sourceSessionId || 'no session link'}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      <div className="two-column-grid jobs-detail-grid">
        <Panel
          title={selectedJob ? `Job #${selectedJob.id}` : 'New job'}
          accent="warm"
        >
          <div className="stack-form">
            <label className="field">
              <span>Title</span>
              <input
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder="Write a concise job title"
              />
            </label>

            <label className="field">
              <span>Details</span>
              <textarea
                rows={7}
                value={draft.details}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    details: event.target.value,
                  }))
                }
                placeholder="Optional delivery notes, context, or acceptance criteria"
              />
            </label>

            <div className="field-grid">
              <label className="field">
                <span>Status</span>
                <select
                  value={draft.status}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      status: event.target.value as JobStatus,
                    }))
                  }
                >
                  {JOB_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Priority</span>
                <select
                  value={draft.priority}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      priority: event.target.value as AdminJob['priority'],
                    }))
                  }
                >
                  <option value="low">low</option>
                  <option value="normal">normal</option>
                  <option value="high">high</option>
                  <option value="urgent">urgent</option>
                </select>
              </label>
            </div>

            <div className="field-grid">
              <label className="field">
                <span>Assignee agent</span>
                <input
                  value={draft.assigneeAgentId}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      assigneeAgentId: event.target.value,
                    }))
                  }
                  placeholder="Optional agent id"
                />
              </label>

              <label className="field">
                <span>Linked task</span>
                <input
                  value={draft.linkedTaskId}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      linkedTaskId: event.target.value,
                    }))
                  }
                  placeholder="Optional scheduler task id"
                />
              </label>
            </div>

            <label className="field">
              <span>Source session</span>
              <input
                value={draft.sourceSessionId}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    sourceSessionId: event.target.value,
                  }))
                }
                placeholder="Optional session id"
              />
            </label>

            <div className="button-row">
              <button
                className="primary-button"
                type="button"
                disabled={saveMutation.isPending || !draft.title.trim()}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending
                  ? 'Saving...'
                  : selectedJob
                    ? 'Save job'
                    : 'Create job'}
              </button>
              {selectedJob ? (
                <button
                  className="danger-button"
                  type="button"
                  disabled={archiveMutation.isPending}
                  onClick={() => archiveMutation.mutate(true)}
                >
                  {archiveMutation.isPending ? 'Updating...' : 'Archive job'}
                </button>
              ) : null}
            </div>

            {selectedJob ? (
              <div className="key-value-grid">
                <div>
                  <span>Created</span>
                  <strong>{formatDateTime(selectedJob.createdAt)}</strong>
                </div>
                <div>
                  <span>Updated</span>
                  <strong>{formatDateTime(selectedJob.updatedAt)}</strong>
                </div>
                <div>
                  <span>Created by</span>
                  <strong>
                    {selectedJob.createdById
                      ? `${selectedJob.createdByKind}:${selectedJob.createdById}`
                      : selectedJob.createdByKind}
                  </strong>
                </div>
                <div>
                  <span>Completed</span>
                  <strong>{formatDateTime(selectedJob.completedAt)}</strong>
                </div>
                <div>
                  <span>Dispatch</span>
                  <strong>
                    {selectedJob.dispatch?.summary || 'No agent activity yet'}
                  </strong>
                </div>
                <div>
                  <span>Attempts</span>
                  <strong>
                    {selectedJob.dispatch
                      ? `${selectedJob.dispatch.attemptCount}/${selectedJob.dispatch.maxAttempts}`
                      : '0/3'}
                  </strong>
                </div>
              </div>
            ) : null}

            {saveMutation.isError ? (
              <p className="error-banner">
                {(saveMutation.error as Error).message}
              </p>
            ) : null}
            {archiveMutation.isError ? (
              <p className="error-banner">
                {(archiveMutation.error as Error).message}
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel title="History">
          {!selectedJob ? (
            <div className="empty-state">
              Select a job to inspect its history.
            </div>
          ) : historyQuery.isLoading ? (
            <div className="empty-state">Loading job history...</div>
          ) : historyQuery.data?.events.length ? (
            <div className="list-stack">
              {historyQuery.data.events.map((event) => (
                <div className="list-row" key={event.id}>
                  <div>
                    <strong>{formatEventAction(event.action)}</strong>
                    <small>
                      {event.actorId
                        ? `${event.actorKind}:${event.actorId}`
                        : event.actorKind}
                    </small>
                    <small>
                      {summarizeEventPayload(event.action, event.payloadJson)}
                    </small>
                  </div>
                  <span>{formatRelativeTime(event.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No history recorded yet.</div>
          )}
        </Panel>
      </div>
    </div>
  );
}
