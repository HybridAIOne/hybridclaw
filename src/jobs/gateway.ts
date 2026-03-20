import {
  createAgentJob,
  getAgentJobById,
  listAgentJobEvents,
  listAgentJobs,
  moveAgentJob,
  setAgentJobArchived,
  updateAgentJob,
} from '../memory/db.js';
import type {
  GatewayAdminJob,
  GatewayAdminJobHistoryResponse,
  GatewayAdminJobsResponse,
  GatewayCommandRequest,
  GatewayCommandResult,
} from '../gateway/gateway-types.js';
import {
  AGENT_JOB_PRIORITIES,
  AGENT_JOB_STATUSES,
  type AgentJob,
  type AgentJobActorKind,
  type AgentJobEvent,
  type AgentJobPriority,
  type AgentJobStatus,
} from '../types.js';
import { inspectAgentJobDispatchState } from './dispatch-state.js';

export const AGENT_JOB_BOARD_ID = 'main';

const AGENT_JOB_STATUS_LABELS: Record<AgentJobStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
};
const AGENT_JOB_STATUS_INDEX = new Map(
  AGENT_JOB_STATUSES.map((status, index) => [status, index] as const),
);
const AGENT_JOB_PRIORITY_INDEX = new Map(
  AGENT_JOB_PRIORITIES.map((priority, index) => [priority, index] as const),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

function infoCommand(
  title: string,
  text: string,
  components?: GatewayCommandResult['components'],
  extra?: Partial<GatewayCommandResult>,
): GatewayCommandResult {
  return {
    kind: 'info',
    title,
    text,
    ...(components === undefined ? {} : { components }),
    ...(extra || {}),
  };
}

function plainCommand(text: string): GatewayCommandResult {
  return { kind: 'plain', text };
}

function normalizeAgentJobActorId(value: unknown): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeAdminActorKind(value: unknown): AgentJobActorKind {
  return value === 'agent' || value === 'system' ? value : 'user';
}

function parseAgentJobId(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Expected positive numeric `jobId`.');
  }
  return Math.trunc(parsed);
}

function parseOptionalLanePosition(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error('Expected numeric `position`.');
  }
  return Math.max(0, Math.trunc(parsed));
}

export function isAgentJobStatusValue(
  value: string,
): value is AgentJobStatus {
  return (AGENT_JOB_STATUSES as readonly string[]).includes(value);
}

function isAgentJobPriorityValue(value: string): value is AgentJobPriority {
  return (AGENT_JOB_PRIORITIES as readonly string[]).includes(value);
}

function parseAgentJobStatus(
  value: unknown,
  fallback?: AgentJobStatus,
): AgentJobStatus {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    if (fallback) return fallback;
    throw new Error('Agent job status is required.');
  }
  if (!isAgentJobStatusValue(normalized)) {
    throw new Error(
      `Agent job status must be one of: ${AGENT_JOB_STATUSES.join(', ')}.`,
    );
  }
  return normalized;
}

function parseAgentJobPriority(
  value: unknown,
  fallback: AgentJobPriority = 'normal',
): AgentJobPriority {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (!isAgentJobPriorityValue(normalized)) {
    throw new Error(
      `Agent job priority must be one of: ${AGENT_JOB_PRIORITIES.join(', ')}.`,
    );
  }
  return normalized;
}

function parseOptionalJobString(value: unknown): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function parseOptionalJobTaskId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Expected positive numeric `linkedTaskId`.');
  }
  return Math.trunc(parsed);
}

function parseAgentJobCreateInput(value: unknown): {
  title: string;
  details?: string | null;
  status: AgentJobStatus;
  priority: AgentJobPriority;
  assigneeAgentId?: string | null;
  sourceSessionId?: string | null;
  linkedTaskId?: number | null;
} {
  if (!isRecord(value)) {
    throw new Error('Expected object `job`.');
  }
  const title = String(value.title || '').trim();
  if (!title) {
    throw new Error('Agent job requires a non-empty `title`.');
  }
  return {
    title,
    details: parseOptionalJobString(value.details),
    status: parseAgentJobStatus(value.status, 'backlog'),
    priority: parseAgentJobPriority(value.priority),
    assigneeAgentId: parseOptionalJobString(value.assigneeAgentId),
    sourceSessionId: parseOptionalJobString(value.sourceSessionId),
    linkedTaskId: parseOptionalJobTaskId(value.linkedTaskId),
  };
}

function parseAgentJobPatchInput(value: unknown): {
  title?: string;
  details?: string;
  priority?: AgentJobPriority;
  assigneeAgentId?: string | null;
  sourceSessionId?: string | null;
  linkedTaskId?: number | null;
  archived?: boolean;
} {
  if (!isRecord(value)) {
    throw new Error('Expected object `patch`.');
  }
  const patch: {
    title?: string;
    details?: string;
    priority?: AgentJobPriority;
    assigneeAgentId?: string | null;
    sourceSessionId?: string | null;
    linkedTaskId?: number | null;
    archived?: boolean;
  } = {};
  if ('title' in value) {
    const title = String(value.title || '').trim();
    if (!title) {
      throw new Error('Agent job `title` cannot be empty.');
    }
    patch.title = title;
  }
  if ('details' in value) {
    patch.details = String(value.details || '').trim();
  }
  if ('priority' in value) {
    patch.priority = parseAgentJobPriority(value.priority);
  }
  if ('assigneeAgentId' in value) {
    patch.assigneeAgentId = parseOptionalJobString(value.assigneeAgentId);
  }
  if ('sourceSessionId' in value) {
    patch.sourceSessionId = parseOptionalJobString(value.sourceSessionId);
  }
  if ('linkedTaskId' in value) {
    patch.linkedTaskId = parseOptionalJobTaskId(value.linkedTaskId);
  }
  if ('archived' in value) {
    patch.archived = value.archived === true;
  }
  return patch;
}

function mapGatewayAdminJob(job: AgentJob): GatewayAdminJob {
  const dispatch = inspectAgentJobDispatchState(job, listAgentJobEvents(job.id));
  return {
    id: job.id,
    boardId: job.board_id,
    title: job.title,
    details: job.details,
    status: job.status,
    priority: job.priority,
    assigneeAgentId: job.assignee_agent_id,
    createdByKind: job.created_by_kind,
    createdById: job.created_by_id,
    sourceSessionId: job.source_session_id,
    linkedTaskId: job.linked_task_id,
    lanePosition: job.lane_position,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
    archivedAt: job.archived_at,
    dispatch,
  };
}

function mapGatewayAdminJobEvent(
  event: AgentJobEvent,
): GatewayAdminJobHistoryResponse['events'][number] {
  return {
    id: event.id,
    jobId: event.job_id,
    actorKind: event.actor_kind,
    actorId: event.actor_id,
    action: event.action,
    payloadJson: event.payload_json,
    createdAt: event.created_at,
  };
}

function compareGatewayAdminJobs(left: AgentJob, right: AgentJob): number {
  const statusDelta =
    (AGENT_JOB_STATUS_INDEX.get(left.status) ?? 99) -
    (AGENT_JOB_STATUS_INDEX.get(right.status) ?? 99);
  if (statusDelta !== 0) return statusDelta;
  if (left.lane_position !== right.lane_position) {
    return left.lane_position - right.lane_position;
  }
  const priorityDelta =
    (AGENT_JOB_PRIORITY_INDEX.get(right.priority) ?? 0) -
    (AGENT_JOB_PRIORITY_INDEX.get(left.priority) ?? 0);
  if (priorityDelta !== 0) return priorityDelta;
  return left.id - right.id;
}

function buildGatewayAdminJobsResponse(params?: {
  boardId?: string;
  includeArchived?: boolean;
}): GatewayAdminJobsResponse {
  const boardId = parseOptionalJobString(params?.boardId) || AGENT_JOB_BOARD_ID;
  const jobs = listAgentJobs({
    boardId,
    includeArchived: params?.includeArchived,
  }).sort(compareGatewayAdminJobs);
  return {
    boardId,
    columns: AGENT_JOB_STATUSES.map((status) => ({
      id: status,
      label: AGENT_JOB_STATUS_LABELS[status],
      count: jobs.filter((job) => job.status === status && !job.archived_at)
        .length,
    })),
    jobs: jobs.map(mapGatewayAdminJob),
  };
}

function parseJobMoveInput(value: unknown): {
  status: AgentJobStatus;
  position?: number;
} {
  if (!isRecord(value)) {
    throw new Error('Expected object `move`.');
  }
  return {
    status: parseAgentJobStatus(value.status),
    position: parseOptionalLanePosition(value.position),
  };
}

function truncateJobBoardLine(value: string, width: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= width) return normalized;
  return `${normalized.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
}

function renderJobBoardCard(job: GatewayAdminJob): string[] {
  const meta = [
    job.priority !== 'normal' ? job.priority.toUpperCase() : null,
    job.dispatch?.summary || job.assigneeAgentId || 'unassigned',
    job.sourceSessionId ? `session ${job.sourceSessionId}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines = [
    `  ${truncateJobBoardLine(`#${job.id} ${job.title}`, 54)}`,
  ];
  if (meta) {
    lines.push(`    ${truncateJobBoardLine(meta, 52)}`);
  }
  return lines;
}

function renderJobBoard(result: GatewayAdminJobsResponse): string {
  const sections: string[] = [];
  for (const status of AGENT_JOB_STATUSES) {
    const jobs = result.jobs.filter(
      (job) => !job.archivedAt && job.status === status,
    );
    sections.push(`${AGENT_JOB_STATUS_LABELS[status]} (${jobs.length})`);
    if (jobs.length === 0) {
      sections.push('  (empty)');
    } else {
      for (const job of jobs) {
        sections.push(...renderJobBoardCard(job));
      }
    }
    sections.push('');
  }
  return sections.join('\n').trimEnd();
}

export function getGatewayAdminJobs(params?: {
  boardId?: string;
  includeArchived?: boolean;
}): GatewayAdminJobsResponse {
  return buildGatewayAdminJobsResponse(params);
}

export function getGatewayAdminJobHistory(
  jobId: number,
): GatewayAdminJobHistoryResponse {
  const job = getAgentJobById(jobId);
  return {
    job: job ? mapGatewayAdminJob(job) : null,
    events: listAgentJobEvents(jobId).map(mapGatewayAdminJobEvent),
  };
}

export function createGatewayAdminJob(input: {
  job: unknown;
  actorKind?: AgentJobActorKind;
  actorId?: string | null;
  boardId?: string;
}): GatewayAdminJobsResponse {
  const actorKind = normalizeAdminActorKind(input.actorKind);
  const actorId = normalizeAgentJobActorId(input.actorId);
  const job = parseAgentJobCreateInput(input.job);
  createAgentJob({
    boardId: parseOptionalJobString(input.boardId) || AGENT_JOB_BOARD_ID,
    title: job.title,
    details: job.details,
    status: job.status,
    priority: job.priority,
    assigneeAgentId: job.assigneeAgentId,
    createdByKind: actorKind,
    createdById: actorId,
    sourceSessionId: job.sourceSessionId,
    linkedTaskId: job.linkedTaskId,
  });
  return buildGatewayAdminJobsResponse();
}

export function updateGatewayAdminJob(input: {
  jobId: unknown;
  patch: unknown;
  actorKind?: AgentJobActorKind;
  actorId?: string | null;
}): GatewayAdminJobsResponse {
  const jobId = parseAgentJobId(input.jobId);
  const patch = parseAgentJobPatchInput(input.patch);
  const actorKind = normalizeAdminActorKind(input.actorKind);
  const actorId = normalizeAgentJobActorId(input.actorId);

  if (patch.archived !== undefined) {
    setAgentJobArchived({
      id: jobId,
      archived: patch.archived,
      actorKind,
      actorId,
    });
  }
  const hasEditableField =
    patch.title !== undefined ||
    patch.details !== undefined ||
    patch.priority !== undefined ||
    patch.assigneeAgentId !== undefined ||
    patch.sourceSessionId !== undefined ||
    patch.linkedTaskId !== undefined;
  if (hasEditableField) {
    updateAgentJob({
      id: jobId,
      title: patch.title,
      details: patch.details,
      priority: patch.priority,
      assigneeAgentId: patch.assigneeAgentId,
      sourceSessionId: patch.sourceSessionId,
      linkedTaskId: patch.linkedTaskId,
      actorKind,
      actorId,
    });
  }
  return buildGatewayAdminJobsResponse();
}

export function moveGatewayAdminJob(input: {
  jobId: unknown;
  move: unknown;
  actorKind?: AgentJobActorKind;
  actorId?: string | null;
}): GatewayAdminJobsResponse {
  const jobId = parseAgentJobId(input.jobId);
  const move = parseJobMoveInput(input.move);
  moveAgentJob({
    id: jobId,
    status: move.status,
    position: move.position,
    actorKind: normalizeAdminActorKind(input.actorKind),
    actorId: normalizeAgentJobActorId(input.actorId),
  });
  return buildGatewayAdminJobsResponse();
}

export function handleGatewayJobCommand(
  req: GatewayCommandRequest,
): GatewayCommandResult {
  const sub = (req.args[1] || 'list').toLowerCase();

  if (sub === 'list') {
    const maybeStatus = String(req.args[2] || '')
      .trim()
      .toLowerCase();
    if (
      maybeStatus &&
      maybeStatus !== 'all' &&
      !isAgentJobStatusValue(maybeStatus)
    ) {
      return badCommand(
        'Usage',
        `Usage: \`job list [${AGENT_JOB_STATUSES.join('|')}]\``,
      );
    }
    const jobs = listAgentJobs({
      boardId: AGENT_JOB_BOARD_ID,
      status:
        maybeStatus && maybeStatus !== 'all'
          ? parseAgentJobStatus(maybeStatus)
          : undefined,
    });
    if (jobs.length === 0) return plainCommand('No jobs on the board.');
    const list = jobs
      .slice(0, 50)
      .map((job) => {
        const meta = [
          job.status,
          job.priority,
          job.assignee_agent_id ? `assignee ${job.assignee_agent_id}` : '',
          job.source_session_id ? `session ${job.source_session_id}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return `#${job.id} ${job.title}${meta ? ` — ${meta}` : ''}`;
      })
      .join('\n');
    return infoCommand('Jobs', list);
  }

  if (sub === 'board') {
    const board = getGatewayAdminJobs();
    if (board.jobs.length === 0) {
      return plainCommand('No jobs on the board.');
    }
    return infoCommand('Jobs Board', renderJobBoard(board), undefined, {
      preformatted: true,
    });
  }

  if (sub === 'create') {
    const title = req.args.slice(2).join(' ').trim();
    if (!title) {
      return badCommand('Usage', 'Usage: `job create <title>`');
    }
    const created = createAgentJob({
      boardId: AGENT_JOB_BOARD_ID,
      title,
      status: 'backlog',
      priority: 'normal',
      createdByKind: 'user',
      createdById: req.username || req.userId || 'user',
      sourceSessionId: req.sessionId,
    });
    return plainCommand(`Job #${created.id} created in backlog: ${created.title}`);
  }

  if (sub === 'edit' || sub === 'open' || sub === 'view') {
    if (!req.args[2]) {
      return badCommand('Usage', 'Usage: `job edit <id>`');
    }
    const jobId = parseAgentJobId(req.args[2]);
    const history = getGatewayAdminJobHistory(jobId);
    if (!history.job) {
      return badCommand('Not Found', `Job #${jobId} was not found.`);
    }
    const job = history.job;
    const lines = [
      `Title: ${job.title}`,
      `Status: ${job.status} · Priority: ${job.priority}`,
      `Assignee: ${job.assigneeAgentId || 'none'}`,
      `Dispatch: ${job.dispatch?.summary || 'No agent activity yet'}`,
      `Dispatch state: ${job.dispatch?.label || 'n/a'} · Attempts: ${job.dispatch?.attemptCount ?? 0}/${job.dispatch?.maxAttempts ?? 3}`,
      `Session: ${job.sourceSessionId || 'none'} · Task: ${job.linkedTaskId ?? 'none'}`,
      `Created: ${job.createdAt}`,
      `Updated: ${job.updatedAt}`,
      `Archived: ${job.archivedAt || 'no'}`,
      '',
      `Details: ${job.details || '(none)'}`,
    ];
    if (history.events.length > 0) {
      lines.push('', 'Recent history:');
      lines.push(
        ...history.events.slice(0, 6).map((event) => {
          const actor = event.actorId
            ? `${event.actorKind}:${event.actorId}`
            : event.actorKind;
          return `- ${event.createdAt} ${event.action} by ${actor}`;
        }),
      );
    }
    return infoCommand(`Job #${job.id}`, lines.join('\n'));
  }

  if (sub === 'move') {
    if (!req.args[2] || !req.args[3]) {
      return badCommand(
        'Usage',
        `Usage: \`job move <id> <${AGENT_JOB_STATUSES.join('|')}> [position]\``,
      );
    }
    const moved = moveAgentJob({
      id: parseAgentJobId(req.args[2]),
      status: parseAgentJobStatus(req.args[3]),
      position: parseOptionalLanePosition(req.args[4]),
      actorKind: 'user',
      actorId: req.username || req.userId || 'user',
    });
    return plainCommand(`Job #${moved.id} moved to ${moved.status}.`);
  }

  if (sub === 'start') {
    if (!req.args[2]) {
      return badCommand('Usage', 'Usage: `job start <id>`');
    }
    const moved = moveAgentJob({
      id: parseAgentJobId(req.args[2]),
      status: 'in_progress',
      actorKind: 'user',
      actorId: req.username || req.userId || 'user',
    });
    return plainCommand(`Job #${moved.id} started.`);
  }

  if (sub === 'done') {
    if (!req.args[2]) {
      return badCommand('Usage', 'Usage: `job done <id>`');
    }
    const moved = moveAgentJob({
      id: parseAgentJobId(req.args[2]),
      status: 'done',
      actorKind: 'user',
      actorId: req.username || req.userId || 'user',
    });
    return plainCommand(`Job #${moved.id} marked done.`);
  }

  if (sub === 'archive' || sub === 'unarchive') {
    if (!req.args[2]) {
      return badCommand('Usage', `Usage: \`job ${sub} <id>\``);
    }
    const updated = setAgentJobArchived({
      id: parseAgentJobId(req.args[2]),
      archived: sub === 'archive',
      actorKind: 'user',
      actorId: req.username || req.userId || 'user',
    });
    return plainCommand(
      `Job #${updated.id} ${sub === 'archive' ? 'archived' : 'restored'}.`,
    );
  }

  return badCommand(
    'Usage',
    'Usage: `job list [status]` | `job board` | `job create <title>` | `job edit <id>` | `job start <id>` | `job move <id> <status> [position]` | `job done <id>` | `job archive <id>` | `job unarchive <id>`',
  );
}
