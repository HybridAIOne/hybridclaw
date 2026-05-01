import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CSSProperties,
  type DragEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  fetchAdminApprovals,
  fetchJobsContext,
  fetchScheduler,
  moveSchedulerJob,
  resumeInteractiveEscalation,
  saveSchedulerJob,
} from '../api/client';
import type {
  AdminInteractionResponse,
  AdminSchedulerJob,
  AdminSuspendedSession,
  JobAgent,
  JobSession,
} from '../api/types';
import { useAuth } from '../auth';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime } from '../lib/format';

type JobColumnId = 'backlog' | 'in_progress' | 'review' | 'done' | 'cancelled';

interface JobBoardItem {
  key: string;
  job: AdminSchedulerJob;
  suspendedSession?: AdminSuspendedSession;
  session: JobSession | null;
  agentKey: string;
  agentLabel: string;
  column: JobColumnId;
  tone: 'default' | 'progress' | 'review' | 'success' | 'danger';
  stateLabel: string;
  summary: string;
  searchIndex: string;
}

interface JobRuntimeEntry {
  key: string;
  label: string;
  value: string;
}

const JOB_COLUMNS: ReadonlyArray<{
  id: JobColumnId;
  title: string;
}> = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
  { id: 'cancelled', title: 'Cancelled' },
] as const;

function trimText(raw: string | null | undefined, maxLength: number): string {
  const normalized = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

function resolveSchedulerSessionId(job: AdminSchedulerJob): string | null {
  if (job.sessionId) return job.sessionId;
  if (job.source === 'config') return `scheduler:${job.id}`;
  return job.sessionId || null;
}

function deriveColumn(
  job: AdminSchedulerJob,
  session: JobSession | null,
): JobColumnId {
  if (job.boardStatus) return job.boardStatus;
  if (session?.status === 'active') return 'in_progress';
  if (
    job.lastStatus === 'success' &&
    (job.schedule.kind === 'at' ||
      job.schedule.kind === 'one_shot' ||
      !job.nextRunAt)
  ) {
    return 'done';
  }
  if (job.lastStatus === 'success') return 'review';
  return 'backlog';
}

function deriveTone(column: JobColumnId): JobBoardItem['tone'] {
  if (column === 'in_progress') return 'progress';
  if (column === 'review') return 'review';
  if (column === 'done') return 'success';
  if (column === 'cancelled') return 'danger';
  return 'default';
}

function deriveStateLabel(job: AdminSchedulerJob, column: JobColumnId): string {
  if (isJobPaused(job)) return 'paused';
  if (column === 'in_progress') return 'running';
  if (column === 'review' && job.lastStatus === 'error') return 'failed';
  if (column === 'backlog' || column === 'cancelled') return 'queued';
  return 'ready';
}

function buildSuspendedSessionJob(
  session: AdminSuspendedSession,
): AdminSchedulerJob {
  return {
    id: `blocked:${session.sessionId}`,
    source: 'task',
    name: session.blockedLabel,
    description: session.prompt,
    agentId: session.agentId,
    boardStatus: 'review',
    maxRetries: null,
    enabled: true,
    schedule: {
      kind: 'one_shot',
      at: session.createdAt,
      everyMs: null,
      expr: null,
      tz: 'UTC',
    },
    action: { kind: 'system_event', message: session.prompt },
    delivery: { kind: 'last-channel', channel: '', to: '', webhookUrl: '' },
    lastRun: null,
    lastStatus: null,
    nextRunAt: null,
    disabled: false,
    consecutiveErrors: 0,
    createdAt: session.createdAt,
    sessionId: session.sessionId,
    channelId: null,
    taskId: null,
  };
}

function isJobPaused(job: AdminSchedulerJob): boolean {
  if (job.source === 'task') return job.disabled;
  // Config jobs have two distinct flags:
  // - enabled: persisted config switch
  // - disabled: runtime pause / auto-disable state
  return !job.enabled || job.disabled;
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function getAgentPillStyle(agentKey: string): CSSProperties {
  if (!agentKey || agentKey === 'unassigned') {
    return {
      backgroundColor: '#eef2f7',
      color: '#64748b',
    };
  }

  const hue = hashString(agentKey) % 360;
  return {
    backgroundColor: `hsla(${hue}, 72%, 92%, 1)`,
    color: `hsl(${hue}, 64%, 36%)`,
  };
}

function JobCard(props: {
  item: JobBoardItem;
  selected: boolean;
  draggable: boolean;
  onSelect: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  onDragLeave: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLButtonElement>) => void;
}) {
  const { item } = props;

  return (
    <div
      className={[
        'jobs-card-shell',
        props.selected ? 'active' : '',
        props.draggable ? 'draggable' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        className="jobs-card-button"
        type="button"
        draggable={props.draggable}
        onClick={props.onSelect}
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        onDragOver={props.onDragOver}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
      >
        <article className={`jobs-card tone-${item.tone}`}>
          <div className="jobs-card-top">
            <strong>{trimText(item.job.name, 24)}</strong>
          </div>
          <p>{item.summary}</p>
          <small>{item.stateLabel}</small>
          <span
            className="jobs-card-pill"
            style={getAgentPillStyle(item.agentKey)}
          >
            {item.agentLabel}
          </span>
        </article>
      </button>
    </div>
  );
}

function replaceSchedulerJob(
  jobs: AdminSchedulerJob[] | undefined,
  nextJob: AdminSchedulerJob,
): AdminSchedulerJob[] {
  return (jobs || []).map((job) =>
    job.id === nextJob.id && job.source === 'config' ? nextJob : job,
  );
}

function buildJobRuntimeEntries(item: JobBoardItem): JobRuntimeEntry[] {
  const entries: JobRuntimeEntry[] = [];
  const push = (label: string, value: string | null | undefined): void => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    entries.push({
      key: `${item.job.id}:${label.toLowerCase().replace(/\s+/g, '-')}`,
      label,
      value: normalized,
    });
  };
  const pushDate = (label: string, raw: string | null | undefined): void => {
    if (!String(raw || '').trim()) return;
    push(label, formatDateTime(raw || null));
  };

  pushDate('Created', item.job.createdAt || item.session?.startedAt || null);
  pushDate('Last run', item.job.lastRun);
  push(
    'Last status',
    item.job.lastStatus
      ? item.job.lastStatus === 'success'
        ? 'Success'
        : 'Error'
      : null,
  );
  push(
    'Next run',
    item.job.schedule.kind !== 'at' && item.job.schedule.kind !== 'one_shot'
      ? item.job.nextRunAt
      : null,
  );
  push(
    'Consecutive errors',
    item.job.consecutiveErrors > 0 ? String(item.job.consecutiveErrors) : null,
  );
  push(
    'Retries after failure',
    item.job.schedule.kind === 'one_shot' && item.job.maxRetries != null
      ? String(item.job.maxRetries)
      : null,
  );
  pushDate('Session started', item.session?.startedAt || null);
  pushDate('Session last active', item.session?.lastActive || null);

  return entries;
}

function collectJobOutputs(item: JobBoardItem): string[] {
  const values =
    item.session?.output && item.session.output.length > 0
      ? item.session.output
      : item.session?.lastAnswer
        ? [item.session.lastAnswer]
        : item.job.action.kind === 'system_event' &&
            item.job.lastStatus === 'success'
          ? [item.job.action.message]
          : [''];
  const seen = new Set<string>();
  const outputs: string[] = [];
  for (const rawValue of values) {
    const value = String(rawValue || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    outputs.push(value);
  }
  return outputs;
}

function outputKey(prefix: string, value: string): string {
  const normalized = value.trim().slice(0, 48).replace(/\s+/g, '-');
  return `${prefix}:${normalized}`;
}

function JobDetailCard(props: {
  item: JobBoardItem;
  runtime: JobRuntimeEntry[];
  agents: JobAgent[];
  savePending: boolean;
  interactionCode: string;
  interactionPending: boolean;
  onUpdate: (nextJob: AdminSchedulerJob & { source: 'config' }) => void;
  onInteractionCodeChange: (value: string) => void;
  onResumeInteraction: (response: AdminInteractionResponse) => void;
}) {
  const sessionId = resolveSchedulerSessionId(props.item.job);
  const editHref = props.item.suspendedSession
    ? '/admin/approvals'
    : `/admin/scheduler?jobId=${encodeURIComponent(props.item.job.id)}`;
  const outputs = useMemo(() => collectJobOutputs(props.item), [props.item]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<null | 'lane' | 'agent'>(
    null,
  );
  const isEditable = props.item.job.source === 'config';

  function saveConfigUpdate(
    patch: Partial<AdminSchedulerJob & { source: 'config' }>,
  ): void {
    const job = props.item.job;
    if (job.source !== 'config') return;
    props.onUpdate({
      ...job,
      source: 'config',
      ...patch,
    });
    setEditingField(null);
  }

  async function copyOutput(key: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1600);
    } catch {
      setCopiedKey(null);
    }
  }

  return (
    <aside className="jobs-detail">
      <div className="jobs-detail-header">
        <div>
          <span className="eyebrow">Job</span>
          <h4>{props.item.job.name}</h4>
        </div>
        <a className="ghost-button" href={editHref}>
          Edit
        </a>
      </div>

      <div className="jobs-detail-stack">
        <div className="key-value-grid">
          <div>
            <span>Status</span>
            <strong>{props.item.stateLabel}</strong>
          </div>
          <div>
            <span>Lane</span>
            {isEditable && editingField === 'lane' ? (
              <select
                className="jobs-inline-select"
                value={props.item.job.boardStatus || props.item.column}
                onBlur={() => setEditingField(null)}
                onChange={(event) =>
                  saveConfigUpdate({
                    boardStatus: event.target.value as JobColumnId,
                  })
                }
              >
                {JOB_COLUMNS.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.title}
                  </option>
                ))}
              </select>
            ) : (
              <button
                className="jobs-inline-trigger"
                type="button"
                disabled={!isEditable || props.savePending}
                onClick={() => setEditingField('lane')}
              >
                {JOB_COLUMNS.find((column) => column.id === props.item.column)
                  ?.title || props.item.column}
              </button>
            )}
          </div>
          <div>
            <span>Agent</span>
            {isEditable && editingField === 'agent' ? (
              <select
                className="jobs-inline-select"
                value={props.item.job.agentId || ''}
                onBlur={() => setEditingField(null)}
                onChange={(event) =>
                  saveConfigUpdate({
                    agentId: event.target.value || null,
                  })
                }
              >
                <option value="">Unassigned</option>
                {props.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name?.trim()
                      ? `${agent.name} (${agent.id})`
                      : agent.id}
                  </option>
                ))}
              </select>
            ) : (
              <button
                className="jobs-inline-trigger"
                type="button"
                disabled={!isEditable || props.savePending}
                onClick={() => setEditingField('agent')}
              >
                {props.item.agentLabel}
              </button>
            )}
          </div>
          <div>
            <span>Type</span>
            <strong>
              {props.item.job.source === 'task' ? 'task' : 'config'}
            </strong>
          </div>
          <div>
            <span>Session</span>
            <strong>{sessionId || 'n/a'}</strong>
          </div>
          <div>
            <span>Channel</span>
            <strong>
              {props.item.job.channelId || props.item.job.delivery.to || 'n/a'}
            </strong>
          </div>
          {props.item.job.schedule.kind !== 'at' &&
          props.item.job.schedule.kind !== 'one_shot' ? (
            <div>
              <span>Next run</span>
              <strong>{formatDateTime(props.item.job.nextRunAt)}</strong>
            </div>
          ) : null}
        </div>

        <div className="summary-block">
          <span>Description</span>
          <p>{props.item.job.description || props.item.summary}</p>
        </div>

        <div className="summary-block">
          <span>Message</span>
          <p>{props.item.job.action.message || 'No action message.'}</p>
        </div>

        {props.item.suspendedSession ? (
          <div className="summary-block">
            <div className="summary-block-header">
              <span>Resume</span>
              <strong>{props.item.suspendedSession.modality}</strong>
            </div>
            <p className="supporting-text">
              {props.item.suspendedSession.prompt}
            </p>
            <div className="button-row">
              {props.item.suspendedSession.expectedReturnKinds.includes(
                'code',
              ) ? (
                <>
                  <input
                    aria-label={`Code for ${props.item.suspendedSession.sessionId}`}
                    value={props.interactionCode}
                    disabled={props.interactionPending}
                    placeholder="Code"
                    onChange={(event) =>
                      props.onInteractionCodeChange(event.target.value)
                    }
                  />
                  <button
                    className="primary-button"
                    type="button"
                    disabled={props.interactionPending}
                    onClick={() =>
                      props.onResumeInteraction({
                        kind: 'code',
                        value: props.interactionCode.trim(),
                      })
                    }
                  >
                    Resume
                  </button>
                </>
              ) : null}
              {props.item.suspendedSession.expectedReturnKinds.includes(
                'approved',
              ) ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={props.interactionPending}
                  onClick={() =>
                    props.onResumeInteraction({
                      kind: 'approved',
                    })
                  }
                >
                  Approved
                </button>
              ) : null}
              {props.item.suspendedSession.expectedReturnKinds.includes(
                'scanned',
              ) ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={props.interactionPending}
                  onClick={() =>
                    props.onResumeInteraction({
                      kind: 'scanned',
                    })
                  }
                >
                  Scanned
                </button>
              ) : null}
              {props.item.suspendedSession.expectedReturnKinds.includes(
                'declined',
              ) ? (
                <button
                  className="danger-button"
                  type="button"
                  disabled={props.interactionPending}
                  onClick={() =>
                    props.onResumeInteraction({
                      kind: 'declined',
                    })
                  }
                >
                  Decline
                </button>
              ) : null}
              {props.item.suspendedSession.expectedReturnKinds.includes(
                'timeout',
              ) ? (
                <button
                  className="ghost-button"
                  type="button"
                  disabled={props.interactionPending}
                  onClick={() =>
                    props.onResumeInteraction({
                      kind: 'timeout',
                    })
                  }
                >
                  Timeout
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="summary-block">
          <div className="summary-block-header">
            <span>Outputs</span>
            {outputs.length ? (
              <button
                className="ghost-button"
                type="button"
                onClick={() => copyOutput('all', outputs.join('\n\n'))}
              >
                {copiedKey === 'all' ? 'Copied' : 'Copy all'}
              </button>
            ) : null}
          </div>
          {outputs.length ? (
            <div className="jobs-output-list">
              {outputs.map((output) => (
                <div
                  className="jobs-output-card"
                  key={outputKey(props.item.key, output)}
                >
                  <div className="jobs-output-actions">
                    <small>Output</small>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() =>
                        copyOutput(outputKey('copy', output), output)
                      }
                    >
                      {copiedKey === outputKey('copy', output)
                        ? 'Copied'
                        : 'Copy'}
                    </button>
                  </div>
                  <pre className="jobs-output-pre">{output}</pre>
                </div>
              ))}
            </div>
          ) : (
            <p>No outputs captured for this job yet.</p>
          )}
        </div>

        <div className="summary-block">
          <span>Runtime</span>
          {props.runtime.length ? (
            <div className="jobs-runtime-list">
              {props.runtime.map((entry) => (
                <div className="jobs-runtime-row" key={entry.key}>
                  <strong>{entry.label}</strong>
                  <small>{entry.value}</small>
                </div>
              ))}
            </div>
          ) : (
            <p>No runtime details recorded yet.</p>
          )}
        </div>
      </div>
    </aside>
  );
}

export function JobsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dragOverItemKey, setDragOverItemKey] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<JobColumnId | null>(
    null,
  );
  const [interactionCodes, setInteractionCodes] = useState<
    Record<string, string>
  >({});
  const deferredSearch = useDeferredValue(search);

  const schedulerQuery = useQuery({
    queryKey: ['scheduler', auth.token],
    queryFn: () => fetchScheduler(auth.token),
    refetchInterval: 15_000,
  });

  const jobsContextQuery = useQuery({
    queryKey: ['jobs-context', auth.token],
    queryFn: () => fetchJobsContext(auth.token),
    refetchInterval: 15_000,
  });

  const approvalsQuery = useQuery({
    queryKey: ['admin-approvals', auth.token, 'board'],
    queryFn: () => fetchAdminApprovals(auth.token),
    refetchInterval: 15_000,
  });

  const saveJobMutation = useMutation({
    mutationFn: (job: AdminSchedulerJob & { source: 'config' }) =>
      saveSchedulerJob(auth.token, job),
    onMutate: async (job) => {
      await queryClient.cancelQueries({
        queryKey: ['scheduler', auth.token],
      });
      const previous = queryClient.getQueryData<{ jobs: AdminSchedulerJob[] }>([
        'scheduler',
        auth.token,
      ]);
      queryClient.setQueryData<{ jobs: AdminSchedulerJob[] }>(
        ['scheduler', auth.token],
        previous
          ? {
              ...previous,
              jobs: replaceSchedulerJob(previous.jobs, job),
            }
          : previous,
      );
      return { previous };
    },
    onError: (error, _job, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['scheduler', auth.token], context.previous);
      }
      toast.error('Save failed', getErrorMessage(error));
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(['scheduler', auth.token], payload);
    },
  });

  const moveJobMutation = useMutation({
    mutationFn: (payload: {
      jobId: string;
      beforeJobId?: string | null;
      boardStatus: JobColumnId;
    }) =>
      moveSchedulerJob(auth.token, {
        jobId: payload.jobId,
        beforeJobId: payload.beforeJobId,
        boardStatus: payload.boardStatus,
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData(['scheduler', auth.token], payload);
    },
    onError: (error) => {
      toast.error('Move failed', getErrorMessage(error));
    },
  });

  const interactionMutation = useMutation({
    mutationFn: (params: {
      sessionId: string;
      response: AdminInteractionResponse;
    }) => resumeInteractiveEscalation(auth.token, params),
    onSuccess: (_payload, params) => {
      setInteractionCodes((current) => {
        const next = { ...current };
        delete next[params.sessionId];
        return next;
      });
      void queryClient.invalidateQueries({
        queryKey: ['admin-approvals', auth.token],
      });
      toast.success('Blocked session resumed.');
    },
    onError: (error) => {
      toast.error('Failed to resume blocked session', getErrorMessage(error));
    },
  });

  function submitInteractionCode(sessionId: string): void {
    const value = (interactionCodes[sessionId] || '').trim();
    if (!value) {
      toast.error('Code required', 'Enter the operator-provided code first.');
      return;
    }
    interactionMutation.mutate({
      sessionId,
      response: { kind: 'code', value },
    });
  }

  function resumeBlockedSession(
    session: AdminSuspendedSession,
    response: AdminInteractionResponse,
  ): void {
    if (response.kind === 'code') {
      submitInteractionCode(session.sessionId);
      return;
    }
    interactionMutation.mutate({
      sessionId: session.sessionId,
      response,
    });
  }

  const sessionsById = useMemo(() => {
    return new Map(
      (jobsContextQuery.data?.sessions || []).map((session) => [
        session.sessionId,
        session,
      ]),
    );
  }, [jobsContextQuery.data?.sessions]);

  const agentsById = useMemo(() => {
    return new Map(
      (jobsContextQuery.data?.agents || []).map((agent) => [agent.id, agent]),
    );
  }, [jobsContextQuery.data?.agents]);

  const allItems = useMemo(() => {
    const scheduledItems = (schedulerQuery.data?.jobs || []).map(
      (job): JobBoardItem => {
        const session =
          sessionsById.get(resolveSchedulerSessionId(job) || '') || null;
        const agentId = job.agentId || session?.agentId || 'unassigned';
        const agent = agentsById.get(agentId) || null;
        const agentLabel =
          agent?.name ||
          job.agentId ||
          session?.agentId ||
          (agentId === 'unassigned' ? 'Unassigned' : agentId);
        const column = deriveColumn(job, session);
        const summary =
          trimText(job.description, 28) ||
          trimText(job.action.message, 36) ||
          trimText(job.channelId, 24) ||
          'No summary';

        return {
          key: job.id,
          job,
          session,
          agentKey: agentId,
          agentLabel,
          column,
          tone: deriveTone(column),
          stateLabel: deriveStateLabel(job, column),
          summary,
          searchIndex: [
            job.id,
            job.name,
            summary,
            job.action.message,
            job.description || '',
            agentLabel,
            job.channelId || '',
            job.delivery.to,
          ]
            .join(' ')
            .toLowerCase(),
        };
      },
    );

    const blockedItems = (approvalsQuery.data?.suspendedSessions || []).map(
      (suspendedSession): JobBoardItem => {
        const job = buildSuspendedSessionJob(suspendedSession);
        const agentId = suspendedSession.agentId || 'unassigned';
        const agent = agentsById.get(agentId) || null;
        const agentLabel =
          agent?.name ||
          suspendedSession.agentId ||
          (agentId === 'unassigned' ? 'Unassigned' : agentId);
        return {
          key: job.id,
          job,
          suspendedSession,
          session: null,
          agentKey: agentId,
          agentLabel,
          column: 'review',
          tone: 'danger',
          stateLabel: suspendedSession.blockedLabel,
          summary:
            trimText(suspendedSession.context.host, 24) ||
            trimText(suspendedSession.prompt, 32) ||
            'Needs operator',
          searchIndex: [
            job.id,
            job.name,
            suspendedSession.prompt,
            suspendedSession.context.host || '',
            suspendedSession.modality,
            agentLabel,
          ]
            .join(' ')
            .toLowerCase(),
        };
      },
    );

    return [...blockedItems, ...scheduledItems];
  }, [
    agentsById,
    approvalsQuery.data?.suspendedSessions,
    schedulerQuery.data?.jobs,
    sessionsById,
  ]);

  const visibleItems = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    if (!needle) return allItems;
    return allItems.filter((item) => item.searchIndex.includes(needle));
  }, [allItems, deferredSearch]);

  const allItemsByKey = useMemo(
    () => new Map(allItems.map((item) => [item.key, item])),
    [allItems],
  );

  const visibleItemKeys = useMemo(
    () => new Set(visibleItems.map((item) => item.key)),
    [visibleItems],
  );

  const itemsByColumn = useMemo(() => {
    return JOB_COLUMNS.map((column) => ({
      ...column,
      items: visibleItems.filter((item) => item.column === column.id),
    }));
  }, [visibleItems]);

  const selectedItem = useMemo(
    () => (selectedKey ? allItemsByKey.get(selectedKey) || null : null),
    [allItemsByKey, selectedKey],
  );

  useEffect(() => {
    if (selectedKey === null) return;
    if (!selectedItem || !visibleItemKeys.has(selectedKey)) {
      setSelectedKey(null);
    }
  }, [selectedItem, selectedKey, visibleItemKeys]);

  const selectedRuntime = useMemo(
    () => (selectedItem ? buildJobRuntimeEntries(selectedItem) : []),
    [selectedItem],
  );

  const draggedItem = useMemo(
    () => allItems.find((item) => item.key === draggedKey) || null,
    [allItems, draggedKey],
  );

  function handleDrop(
    column: JobColumnId,
    beforeJobId: string | null = null,
  ): void {
    if (!draggedItem || draggedItem.job.source !== 'config') return;
    if (beforeJobId === draggedItem.job.id) {
      setDraggedKey(null);
      setDragOverItemKey(null);
      setDragOverColumn(null);
      return;
    }
    moveJobMutation.mutate({
      jobId: draggedItem.job.id,
      beforeJobId,
      boardStatus: column,
    });
    setDraggedKey(null);
    setDragOverItemKey(null);
    setDragOverColumn(null);
  }

  if (schedulerQuery.isLoading && !schedulerQuery.data) {
    return <div className="empty-state">Loading jobs board...</div>;
  }

  if (schedulerQuery.isError && !schedulerQuery.data) {
    return (
      <div className="empty-state error">
        {getErrorMessage(schedulerQuery.error)}
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={`Kanban Board (${visibleItems.length} task${visibleItems.length === 1 ? '' : 's'})`}
        actions={
          <div className="header-actions">
            <input
              className="compact-search jobs-header-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search jobs"
            />
            <a className="primary-button" href="/admin/scheduler">
              New Job
            </a>
          </div>
        }
      />

      {/* Query errors stay as inline banners (not toasts) — they represent a
          persistent broken state, not a one-time operation failure. */}
      {jobsContextQuery.isError ? (
        <p className="error-banner">
          {getErrorMessage(jobsContextQuery.error)}
        </p>
      ) : null}

      <section
        className={
          selectedItem ? 'jobs-board-layout has-detail' : 'jobs-board-layout'
        }
      >
        <div className="jobs-columns">
          {itemsByColumn.map((column) => (
            <fieldset
              aria-label={`${column.title} jobs`}
              className={
                dragOverColumn === column.id
                  ? `jobs-column jobs-column-${column.id} drop-target`
                  : `jobs-column jobs-column-${column.id}`
              }
              key={column.id}
              onDragOver={(event) => {
                if (!draggedItem || draggedItem.job.source !== 'config') return;
                event.preventDefault();
                if (dragOverColumn !== column.id) {
                  setDragOverColumn(column.id);
                }
              }}
              onDragLeave={(event) => {
                if (
                  event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  return;
                }
                if (dragOverColumn === column.id) {
                  setDragOverColumn(null);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(column.id, null);
              }}
            >
              <div className="jobs-column-header">
                <strong>{column.title}</strong>
                <span>{column.items.length}</span>
              </div>

              <div className="jobs-column-body">
                {column.items.length ? (
                  column.items.map((item) => (
                    <div
                      key={item.key}
                      className={[
                        'jobs-card-frame',
                        dragOverItemKey === item.key ? 'drop-target' : '',
                        item.key === draggedKey ? 'dragging' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <JobCard
                        item={item}
                        selected={item.key === selectedItem?.key}
                        draggable={item.job.source === 'config'}
                        onSelect={() =>
                          setSelectedKey((current) =>
                            current === item.key ? null : item.key,
                          )
                        }
                        onDragStart={(event) => {
                          if (item.job.source !== 'config') return;
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', item.key);
                          setDraggedKey(item.key);
                        }}
                        onDragEnd={() => {
                          setDraggedKey(null);
                          setDragOverItemKey(null);
                          setDragOverColumn(null);
                        }}
                        onDragOver={(event) => {
                          if (
                            !draggedItem ||
                            draggedItem.job.source !== 'config'
                          )
                            return;
                          if (item.job.source !== 'config') return;
                          event.preventDefault();
                          event.stopPropagation();
                          if (dragOverItemKey !== item.key) {
                            setDragOverItemKey(item.key);
                          }
                          if (dragOverColumn !== column.id) {
                            setDragOverColumn(column.id);
                          }
                        }}
                        onDragLeave={(event) => {
                          const nextTarget = event.relatedTarget;
                          if (
                            nextTarget instanceof Node &&
                            event.currentTarget.contains(nextTarget)
                          ) {
                            return;
                          }
                          if (dragOverItemKey === item.key) {
                            setDragOverItemKey(null);
                          }
                        }}
                        onDrop={(event) => {
                          if (item.job.source !== 'config') return;
                          event.preventDefault();
                          event.stopPropagation();
                          handleDrop(column.id, item.job.id);
                        }}
                      />
                    </div>
                  ))
                ) : (
                  <div className="jobs-column-empty">No jobs</div>
                )}
              </div>
            </fieldset>
          ))}
        </div>

        {selectedItem ? (
          <JobDetailCard
            item={selectedItem}
            runtime={selectedRuntime}
            agents={jobsContextQuery.data?.agents || []}
            savePending={saveJobMutation.isPending}
            interactionCode={
              selectedItem.suspendedSession
                ? interactionCodes[selectedItem.suspendedSession.sessionId] ||
                  ''
                : ''
            }
            interactionPending={interactionMutation.isPending}
            onUpdate={(job) => saveJobMutation.mutate(job)}
            onInteractionCodeChange={(value) => {
              if (!selectedItem.suspendedSession) return;
              setInteractionCodes((current) => ({
                ...current,
                [selectedItem.suspendedSession?.sessionId || '']: value,
              }));
            }}
            onResumeInteraction={(response) => {
              if (!selectedItem.suspendedSession) return;
              resumeBlockedSession(selectedItem.suspendedSession, response);
            }}
          />
        ) : null}
      </section>
    </div>
  );
}
