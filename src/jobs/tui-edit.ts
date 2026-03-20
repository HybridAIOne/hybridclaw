import readline from 'node:readline';
import type {
  GatewayAdminAgent,
  GatewayHistoryMessage,
  GatewayAdminJob,
  GatewayAdminJobEvent,
} from '../gateway/gateway-types.js';
import type { AgentJobPriority, AgentJobStatus } from '../types.js';

const JOB_STATUS_CHOICES = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'done',
] as const satisfies readonly AgentJobStatus[];

const JOB_PRIORITY_CHOICES = [
  'low',
  'normal',
  'high',
  'urgent',
] as const satisfies readonly AgentJobPriority[];

const FIELD_ORDER = [
  'title',
  'details',
  'status',
  'priority',
  'assignee',
  'sourceSession',
  'linkedTask',
  'save',
  'cancel',
] as const;

type TuiJobEditFieldId = (typeof FIELD_ORDER)[number];

type InternalReadline = readline.Interface & {
  line: string;
  cursor: number;
  _refreshLine?: () => void;
};

interface TuiJobEditInput {
  isTTY?: boolean;
  on(
    event: 'keypress',
    listener: (chunk: string, key: readline.Key) => void,
  ): this;
  off(
    event: 'keypress',
    listener: (chunk: string, key: readline.Key) => void,
  ): this;
}

interface TuiJobEditAssigneeOption {
  id: string | null;
  label: string;
}

interface TuiJobEditDraft {
  title: string;
  details: string;
  status: AgentJobStatus;
  priority: AgentJobPriority;
  assigneeAgentId: string | null;
  sourceSessionId: string | null;
  linkedTaskId: number | null;
}

export interface TuiJobEditPalette {
  reset: string;
  bold: string;
  muted: string;
  teal: string;
  gold: string;
  green: string;
  red: string;
}

const DEFAULT_TUI_JOB_EDIT_PALETTE: Readonly<TuiJobEditPalette> = Object.freeze(
  {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    muted: '\x1b[90m',
    teal: '\x1b[36m',
    gold: '\x1b[33m',
    green: '\x1b[32m',
    red: '\x1b[31m',
  },
);
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

export interface TuiJobEditPatch {
  title?: string;
  details?: string;
  priority?: AgentJobPriority;
  assigneeAgentId?: string | null;
  sourceSessionId?: string | null;
  linkedTaskId?: number | null;
}

export interface TuiJobEditResult {
  cancelled: boolean;
  status?: AgentJobStatus;
  patch: TuiJobEditPatch;
}

function resolvePalette(
  palette?: Partial<TuiJobEditPalette>,
): TuiJobEditPalette {
  return {
    ...DEFAULT_TUI_JOB_EDIT_PALETTE,
    ...(palette || {}),
  };
}

function getAnsiSequenceLength(value: string, index: number): number {
  if (value.charCodeAt(index) !== 27 || value[index + 1] !== '[') {
    return 0;
  }

  let cursor = index + 2;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code >= 64 && code <= 126) {
      return cursor - index + 1;
    }
    cursor += 1;
  }

  return 0;
}

function truncateLine(value: string, width: number): string {
  if (width <= 0) return '';
  let visibleLength = 0;
  for (let index = 0; index < value.length; ) {
    const ansiSequenceLength = getAnsiSequenceLength(value, index);
    if (ansiSequenceLength > 0) {
      index += ansiSequenceLength;
      continue;
    }
    visibleLength += 1;
    index += 1;
  }
  if (visibleLength <= width) return value;

  const targetVisibleLength = width === 1 ? 1 : width - 1;
  let output = '';
  let writtenVisibleLength = 0;
  const hasAnsi = value.includes('\x1b[');

  for (
    let index = 0;
    index < value.length && writtenVisibleLength < targetVisibleLength;
  ) {
    const ansiSequenceLength = getAnsiSequenceLength(value, index);
    if (ansiSequenceLength > 0) {
      output += value.slice(index, index + ansiSequenceLength);
      index += ansiSequenceLength;
      continue;
    }
    output += value[index] || '';
    writtenVisibleLength += 1;
    index += 1;
  }

  if (width === 1) return hasAnsi ? `${output}\x1b[0m` : output;
  return hasAnsi ? `${output}…\x1b[0m` : `${output}…`;
}

function stripAndNormalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatStatusLabel(status: AgentJobStatus): string {
  return status === 'in_progress' ? 'in progress' : status;
}

function createDraft(job: GatewayAdminJob): TuiJobEditDraft {
  return {
    title: job.title,
    details: job.details,
    status: job.status,
    priority: job.priority,
    assigneeAgentId: job.assigneeAgentId,
    sourceSessionId: job.sourceSessionId,
    linkedTaskId: job.linkedTaskId,
  };
}

function buildAssigneeOptions(
  job: GatewayAdminJob,
  agents: GatewayAdminAgent[],
): TuiJobEditAssigneeOption[] {
  const options: TuiJobEditAssigneeOption[] = [
    {
      id: null,
      label: 'unassigned',
    },
  ];
  const seen = new Set<string>();

  for (const agent of agents) {
    const id = String(agent.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: agent.name ? `${id} — ${agent.name}` : id,
    });
  }

  const current = String(job.assigneeAgentId || '').trim();
  if (current && !seen.has(current)) {
    options.push({
      id: current,
      label: `${current} — unavailable`,
    });
  }

  return options;
}

function cycleValue<T>(values: readonly T[], current: T, direction: 1 | -1): T {
  const index = values.findIndex((value) => value === current);
  if (index < 0) return values[0] as T;
  return values[(index + direction + values.length) % values.length] as T;
}

function cycleAssignee(
  options: readonly TuiJobEditAssigneeOption[],
  current: string | null,
  direction: 1 | -1,
): string | null {
  const index = options.findIndex((option) => option.id === current);
  if (index < 0) return options[0]?.id ?? null;
  return (
    options[(index + direction + options.length) % options.length]?.id ?? null
  );
}

function describeAssignee(
  options: readonly TuiJobEditAssigneeOption[],
  current: string | null,
): string {
  return (
    options.find((option) => option.id === current)?.label ||
    current ||
    'unassigned'
  );
}

function summarizeValue(
  value: string | null | undefined,
  fallback: string,
): string {
  const normalized = stripAndNormalize(String(value || ''));
  return normalized || fallback;
}

function buildPatch(
  job: GatewayAdminJob,
  draft: TuiJobEditDraft,
): TuiJobEditResult {
  const patch: TuiJobEditPatch = {};
  if (draft.title !== job.title) patch.title = draft.title;
  if (draft.details !== job.details) patch.details = draft.details;
  if (draft.priority !== job.priority) patch.priority = draft.priority;
  if (draft.assigneeAgentId !== job.assigneeAgentId) {
    patch.assigneeAgentId = draft.assigneeAgentId;
  }
  if (draft.sourceSessionId !== job.sourceSessionId) {
    patch.sourceSessionId = draft.sourceSessionId;
  }
  if (draft.linkedTaskId !== job.linkedTaskId) {
    patch.linkedTaskId = draft.linkedTaskId;
  }
  return {
    cancelled: false,
    status: draft.status !== job.status ? draft.status : undefined,
    patch,
  };
}

function fieldValue(
  field: TuiJobEditFieldId,
  draft: TuiJobEditDraft,
  assigneeOptions: readonly TuiJobEditAssigneeOption[],
): string {
  switch (field) {
    case 'title':
      return summarizeValue(draft.title, 'untitled');
    case 'details':
      return summarizeValue(draft.details, 'no details');
    case 'status':
      return formatStatusLabel(draft.status);
    case 'priority':
      return draft.priority;
    case 'assignee':
      return describeAssignee(assigneeOptions, draft.assigneeAgentId);
    case 'sourceSession':
      return summarizeValue(draft.sourceSessionId, 'none');
    case 'linkedTask':
      return draft.linkedTaskId ? `task ${draft.linkedTaskId}` : 'none';
    case 'save':
      return 'save changes';
    case 'cancel':
      return 'cancel';
  }
}

function fieldLabel(field: TuiJobEditFieldId): string {
  switch (field) {
    case 'title':
      return 'Title';
    case 'details':
      return 'Details';
    case 'status':
      return 'Status';
    case 'priority':
      return 'Priority';
    case 'assignee':
      return 'Assigned To';
    case 'sourceSession':
      return 'Source Session';
    case 'linkedTask':
      return 'Linked Task';
    case 'save':
      return 'Action';
    case 'cancel':
      return 'Action';
  }
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
    return '';
  }
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    if (action === 'dispatch_started') {
      return `attempt ${parsed.attempt || 1}`;
    }
    if (action === 'dispatch_succeeded') {
      return `completed on attempt ${parsed.attempt || 1}`;
    }
    if (action === 'dispatch_failed') {
      const attempt = parsed.attempt || 1;
      const error = String(parsed.error || '').trim();
      return error ? `attempt ${attempt}: ${error}` : `attempt ${attempt} failed`;
    }
    if (action === 'dispatch_exhausted') {
      return `retries exhausted (${parsed.maxAttempts || parsed.attempt || 3})`;
    }
    if (parsed.fromStatus && parsed.toStatus) {
      return `${parsed.fromStatus} -> ${parsed.toStatus}`;
    }
  } catch {
    return normalized;
  }
  return '';
}

function describeJobEvent(event: GatewayAdminJobEvent): string {
  const actor = event.actorId
    ? `${event.actorKind}:${event.actorId}`
    : event.actorKind;
  const payloadSummary = summarizeEventPayload(event.action, event.payloadJson);
  const parts = [
    formatEventAction(event.action),
    actor,
    payloadSummary,
    event.createdAt,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function renderTuiJobEditLines(params: {
  job: GatewayAdminJob;
  draft: TuiJobEditDraft;
  agents?: GatewayAdminAgent[];
  events?: GatewayAdminJobEvent[];
  resultPreview?: string | null;
  hasResultViewer?: boolean;
  cursor: number;
  width: number;
  height: number;
  palette?: Partial<TuiJobEditPalette>;
  notice?: string | null;
}): string[] {
  const palette = resolvePalette(params.palette);
  const width = Math.max(40, params.width || 80);
  const maxHeight = Math.max(12, params.height || 24);
  const assigneeOptions = buildAssigneeOptions(params.job, params.agents || []);
  const controls = [
    '↑↓ move',
    '←→ cycle choices',
    'Enter edit/select',
    params.hasResultViewer ? 'R result' : null,
    'S start',
    'ESC cancel',
  ]
    .filter(Boolean)
    .join('  ');
  const lines = [
    truncateLine(
      `  ${palette.bold}${palette.gold}Job Edit${palette.reset} ${palette.teal}#${params.job.id}${palette.reset}`,
      width,
    ),
    truncateLine(
      `  ${palette.muted}${controls}${palette.reset}`,
      width,
    ),
    truncateLine(
      `  ${palette.muted}Start = set status to ${palette.green}in progress${palette.reset}${palette.muted}. Save applies changes.${palette.reset}`,
      width,
    ),
  ];

  if (params.notice) {
    lines.push(
      truncateLine(`  ${palette.red}${params.notice}${palette.reset}`, width),
    );
  } else {
    lines.push('');
  }

  for (const [index, field] of FIELD_ORDER.entries()) {
    const active = index === params.cursor;
    const marker = active
      ? `${palette.gold}→${palette.reset}`
      : `${palette.muted} ${palette.reset}`;
    const labelColor = active
      ? `${palette.bold}${palette.teal}`
      : palette.muted;
    const valueColor =
      field === 'save'
        ? palette.green
        : field === 'cancel'
          ? palette.red
          : field === 'status' && params.draft.status === 'in_progress'
            ? palette.green
            : palette.reset;
    const label = fieldLabel(field).padEnd(14, ' ');
    const value = fieldValue(field, params.draft, assigneeOptions);
    lines.push(
      truncateLine(
        ` ${marker} ${labelColor}${label}${palette.reset} ${valueColor}${value}${palette.reset}`,
        width,
      ),
    );
  }
  const dispatchSummary =
    params.job.dispatch?.summary || 'No agent activity yet';
  const dispatchMeta = params.job.dispatch
    ? `${params.job.dispatch.label} · ${params.job.dispatch.attemptCount}/${params.job.dispatch.maxAttempts}`
    : 'n/a · 0/3';
  lines.push(
    truncateLine(
      `  ${palette.muted}${'Dispatch'.padEnd(14, ' ')}${palette.reset} ${dispatchSummary} · ${dispatchMeta}`,
      width,
    ),
  );
  lines.push(
    truncateLine(
      `  ${palette.muted}${'Result'.padEnd(14, ' ')}${palette.reset} ${summarizeValue(params.resultPreview, params.job.dispatch?.sessionId ? `stored in ${params.job.dispatch.sessionId}` : 'No dispatch transcript yet')}${params.hasResultViewer ? ' · press R to open' : ''}`,
      width,
    ),
  );
  const availableActivityLines = Math.max(1, maxHeight - (lines.length + 2));
  const recentEvents = (params.events || []).slice(0, availableActivityLines);
  if (recentEvents.length === 0) {
    lines.push(
      truncateLine(
        `  ${palette.muted}${'Activity'.padEnd(14, ' ')}${palette.reset} No recorded job events yet`,
        width,
      ),
    );
  } else {
    for (const [index, event] of recentEvents.entries()) {
      const label = index === 0 ? 'Activity' : 'Recent';
      lines.push(
        truncateLine(
          `  ${palette.muted}${label.padEnd(14, ' ')}${palette.reset} ${describeJobEvent(event)}`,
          width,
        ),
      );
    }
  }
  lines.push(
    truncateLine(
      `  ${palette.bold}${summarizeValue(params.draft.title, 'untitled')}${palette.reset} ${palette.muted}— created by ${params.job.createdByKind}:${params.job.createdById || 'unknown'}${palette.reset}`,
      width,
    ),
  );
  lines.push(
    truncateLine(
      `  ${palette.muted}Updated ${params.job.updatedAt}${params.job.archivedAt ? ` · archived ${params.job.archivedAt}` : ''}${palette.reset}`,
      width,
    ),
  );

  return lines.slice(0, maxHeight);
}

function wrapPlainText(value: string, width: number): string[] {
  const maxWidth = Math.max(10, width);
  const sourceLines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const wrapped: string[] = [];

  for (const sourceLine of sourceLines) {
    const normalized = sourceLine.trim();
    if (!normalized) {
      wrapped.push('');
      continue;
    }
    const words = normalized.split(/\s+/);
    let line = '';
    for (const word of words) {
      if (!line) {
        if (word.length <= maxWidth) {
          line = word;
          continue;
        }
        for (let index = 0; index < word.length; index += maxWidth) {
          wrapped.push(word.slice(index, index + maxWidth));
        }
        line = '';
        continue;
      }
      if (line.length + 1 + word.length <= maxWidth) {
        line = `${line} ${word}`;
        continue;
      }
      wrapped.push(line);
      if (word.length <= maxWidth) {
        line = word;
        continue;
      }
      for (let index = 0; index < word.length; index += maxWidth) {
        const chunk = word.slice(index, index + maxWidth);
        if (chunk.length === maxWidth || index + maxWidth < word.length) {
          wrapped.push(chunk);
        } else {
          line = chunk;
        }
      }
      if (word.length % maxWidth === 0) {
        line = '';
      }
    }
    if (line) wrapped.push(line);
  }

  return wrapped.length > 0 ? wrapped : [''];
}

function buildResultTranscriptLines(
  messages: GatewayHistoryMessage[],
  width: number,
  palette: TuiJobEditPalette,
): string[] {
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const visibleMessages = assistantMessages.length > 0 ? assistantMessages : messages;
  const transcriptLines: string[] = [];

  for (const [index, message] of visibleMessages.entries()) {
    if (index > 0) transcriptLines.push('');
    const roleLabel =
      message.role === 'assistant'
        ? `${palette.bold}${palette.teal}Assistant${palette.reset}`
        : `${palette.bold}${palette.muted}${message.role}${palette.reset}`;
    transcriptLines.push(
      truncateLine(
        `  ${roleLabel} ${palette.muted}${message.created_at}${palette.reset}`,
        width,
      ),
    );
    for (const line of wrapPlainText(message.content, Math.max(20, width - 2))) {
      transcriptLines.push(truncateLine(`  ${line}`, width));
    }
  }

  return transcriptLines.length > 0
    ? transcriptLines
    : [truncateLine(`  ${palette.muted}No dispatch transcript available.${palette.reset}`, width)];
}

export function renderTuiJobResultLines(params: {
  job: GatewayAdminJob;
  messages?: GatewayHistoryMessage[];
  scrollOffset: number;
  width: number;
  height: number;
  palette?: Partial<TuiJobEditPalette>;
}): {
  lines: string[];
  scrollOffset: number;
  maxScrollOffset: number;
} {
  const palette = resolvePalette(params.palette);
  const width = Math.max(40, params.width || 80);
  const height = Math.max(12, params.height || 24);
  const transcriptLines = buildResultTranscriptLines(
    params.messages || [],
    width,
    palette,
  );
  const chromeLines = 5;
  const bodyHeight = Math.max(4, height - chromeLines);
  const maxScrollOffset = Math.max(0, transcriptLines.length - bodyHeight);
  const scrollOffset = Math.max(0, Math.min(maxScrollOffset, params.scrollOffset));
  const visible = transcriptLines.slice(scrollOffset, scrollOffset + bodyHeight);
  const lines = [
    truncateLine(
      `  ${palette.bold}${palette.gold}Job Result${palette.reset} ${palette.teal}#${params.job.id}${palette.reset}`,
      width,
    ),
    truncateLine(
      `  ${palette.muted}↑↓ scroll  PgUp/PgDn jump  Home/End move  ESC back${palette.reset}`,
      width,
    ),
    truncateLine(
      `  ${palette.muted}${params.job.dispatch?.sessionId ? `Dispatch session ${params.job.dispatch.sessionId}` : 'No dispatch session linked'}${palette.reset}`,
      width,
    ),
    truncateLine(
      `  ${palette.muted}Showing ${transcriptLines.length} line${transcriptLines.length === 1 ? '' : 's'} · ${scrollOffset + 1}-${Math.min(scrollOffset + visible.length, transcriptLines.length)}${palette.reset}`,
      width,
    ),
    '',
    ...visible,
  ];

  return {
    lines: lines.slice(0, height),
    scrollOffset,
    maxScrollOffset,
  };
}

async function askQuestion(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function promptTextField(params: {
  rl: readline.Interface;
  label: string;
  current: string;
  allowClear?: boolean;
}): Promise<string> {
  const suffix = params.allowClear
    ? ' (- clears, Enter keeps current)'
    : ' (Enter keeps current)';
  const answer = (
    await askQuestion(
      params.rl,
      `  ${params.label} [${summarizeValue(params.current, 'none')}]${suffix}: `,
    )
  ).trim();
  if (!answer) return params.current;
  if (params.allowClear && answer === '-') return '';
  return answer;
}

async function promptOptionalStringField(params: {
  rl: readline.Interface;
  label: string;
  current: string | null;
}): Promise<string | null> {
  const answer = (
    await askQuestion(
      params.rl,
      `  ${params.label} [${summarizeValue(params.current, 'none')}] (- clears, Enter keeps current): `,
    )
  ).trim();
  if (!answer) return params.current;
  if (answer === '-') return null;
  return answer;
}

async function promptLinkedTaskField(
  rl: readline.Interface,
  current: number | null,
): Promise<number | null> {
  while (true) {
    const answer = (
      await askQuestion(
        rl,
        `  Linked task [${current ?? 'none'}] (- clears, Enter keeps current): `,
      )
    ).trim();
    if (!answer) return current;
    if (answer === '-') return null;
    const parsed = Number.parseInt(answer, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
}

export async function promptTuiJobEdit(params: {
  rl: readline.Interface;
  job: GatewayAdminJob;
  agents?: GatewayAdminAgent[];
  events?: GatewayAdminJobEvent[];
  resultPreview?: string | null;
  resultMessages?: GatewayHistoryMessage[];
  palette?: Partial<TuiJobEditPalette>;
  output?: NodeJS.WriteStream;
  input?: TuiJobEditInput;
}): Promise<TuiJobEditResult> {
  const { rl, job } = params;
  const output = params.output || process.stdout;
  const input = params.input || (process.stdin as TuiJobEditInput);
  const palette = resolvePalette(params.palette);
  const internal = rl as InternalReadline;

  if (!output.isTTY || input.isTTY === false) {
    return {
      cancelled: false,
      patch: {},
    };
  }

  const savedLine = internal.line;
  const savedCursor = internal.cursor;
  const lineListeners = rl.listeners('line') as Array<(line: string) => void>;
  const sigintListeners = rl.listeners('SIGINT') as Array<() => void>;
  const draft = createDraft(job);
  const assigneeOptions = buildAssigneeOptions(job, params.agents || []);
  const hasResultViewer = (params.resultMessages || []).length > 0;
  let cursor = 0;
  let restored = false;
  let prompting = false;
  let notice: string | null = null;
  let mode: 'form' | 'result' = 'form';
  let resultScrollOffset = 0;
  let finish = (_result: TuiJobEditResult) => {};
  let fail = (_error: unknown) => {};

  const clear = () => {
    readline.cursorTo(output, 0, 0);
    readline.clearScreenDown(output);
  };

  const render = () => {
    clear();
    const lines =
      mode === 'result'
        ? (() => {
            const rendered = renderTuiJobResultLines({
              job,
              messages: params.resultMessages,
              scrollOffset: resultScrollOffset,
              width: output.columns || 80,
              height: output.rows || 24,
              palette,
            });
            resultScrollOffset = rendered.scrollOffset;
            return rendered.lines;
          })()
        : renderTuiJobEditLines({
            job,
            draft,
            agents: params.agents,
            events: params.events,
            resultPreview: params.resultPreview,
            hasResultViewer,
            cursor,
            width: output.columns || 80,
            height: output.rows || 24,
            palette,
            notice,
          });
    output.write('\x1b[?25l');
    output.write(lines.join('\n'));
  };

  const restore = () => {
    if (restored) return;
    restored = true;
    output.write('\x1b[?25h');
    output.write(EXIT_ALT_SCREEN);
    input.off('keypress', handleKeypress);
    rl.off('SIGINT', handleSigint);
    for (const listener of lineListeners) {
      rl.on('line', listener);
    }
    for (const listener of sigintListeners) {
      rl.on('SIGINT', listener);
    }
    internal.line = savedLine;
    internal.cursor = Math.min(savedCursor, savedLine.length);
    if (internal._refreshLine) {
      internal._refreshLine();
    } else if (typeof rl.prompt === 'function') {
      rl.prompt(true);
    }
    output.off('resize', render);
  };

  const promptInline = async <T,>(work: () => Promise<T>): Promise<T> => {
    prompting = true;
    clear();
    output.write('\x1b[?25h');
    try {
      return await work();
    } finally {
      output.write('\x1b[?25l');
      prompting = false;
      render();
    }
  };

  const handleSigint = () => {
    finish({
      cancelled: true,
      patch: {},
    });
  };

  const applyFieldEnter = async () => {
    notice = null;
    const field = FIELD_ORDER[cursor] || 'title';

    if (field === 'title') {
      draft.title = await promptInline(() =>
        promptTextField({
          rl,
          label: 'Title',
          current: draft.title,
        }),
      );
      return;
    }

    if (field === 'details') {
      draft.details = await promptInline(() =>
        promptTextField({
          rl,
          label: 'Details',
          current: draft.details,
          allowClear: true,
        }),
      );
      return;
    }

    if (field === 'status') {
      draft.status = cycleValue(JOB_STATUS_CHOICES, draft.status, 1);
      return;
    }

    if (field === 'priority') {
      draft.priority = cycleValue(JOB_PRIORITY_CHOICES, draft.priority, 1);
      return;
    }

    if (field === 'assignee') {
      draft.assigneeAgentId = cycleAssignee(
        assigneeOptions,
        draft.assigneeAgentId,
        1,
      );
      return;
    }

    if (field === 'sourceSession') {
      draft.sourceSessionId = await promptInline(() =>
        promptOptionalStringField({
          rl,
          label: 'Source session',
          current: draft.sourceSessionId,
        }),
      );
      return;
    }

    if (field === 'linkedTask') {
      draft.linkedTaskId = await promptInline(() =>
        promptLinkedTaskField(rl, draft.linkedTaskId),
      );
      return;
    }

    if (field === 'save') {
      finish(buildPatch(job, draft));
      return;
    }

    finish({
      cancelled: true,
      patch: {},
    });
  };

  const cycleCurrentField = (direction: 1 | -1) => {
    notice = null;
    const field = FIELD_ORDER[cursor] || 'title';
    if (field === 'status') {
      draft.status = cycleValue(JOB_STATUS_CHOICES, draft.status, direction);
      return;
    }
    if (field === 'priority') {
      draft.priority = cycleValue(
        JOB_PRIORITY_CHOICES,
        draft.priority,
        direction,
      );
      return;
    }
    if (field === 'assignee') {
      draft.assigneeAgentId = cycleAssignee(
        assigneeOptions,
        draft.assigneeAgentId,
        direction,
      );
    }
  };

  const handleKeypress = (_chunk: string, key: readline.Key) => {
    if (prompting) return;

    if (key.ctrl === true && key.name === 'c') {
      finish({
        cancelled: true,
        patch: {},
      });
      return;
    }

    if (mode === 'result') {
      if (key.name === 'escape' || key.name === 'q' || key.name === 'return') {
        mode = 'form';
        render();
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        resultScrollOffset = Math.max(0, resultScrollOffset - 1);
        render();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        resultScrollOffset += 1;
        render();
        return;
      }
      if (key.name === 'pageup') {
        resultScrollOffset = Math.max(
          0,
          resultScrollOffset - Math.max(4, Math.floor((output.rows || 24) / 2)),
        );
        render();
        return;
      }
      if (key.name === 'pagedown') {
        resultScrollOffset += Math.max(4, Math.floor((output.rows || 24) / 2));
        render();
        return;
      }
      if (key.name === 'home') {
        resultScrollOffset = 0;
        render();
        return;
      }
      if (key.name === 'end') {
        resultScrollOffset = Number.MAX_SAFE_INTEGER;
        render();
      }
      return;
    }

    if (key.name === 'escape' || key.name === 'q') {
      finish({
        cancelled: true,
        patch: {},
      });
      return;
    }

    if (key.name === 'up' || key.name === 'k') {
      notice = null;
      cursor = (cursor - 1 + FIELD_ORDER.length) % FIELD_ORDER.length;
      render();
      return;
    }

    if (key.name === 'down' || key.name === 'j') {
      notice = null;
      cursor = (cursor + 1) % FIELD_ORDER.length;
      render();
      return;
    }

    if (key.name === 'left' || key.name === 'h') {
      cycleCurrentField(-1);
      render();
      return;
    }

    if (key.name === 'right' || key.name === 'l') {
      cycleCurrentField(1);
      render();
      return;
    }

    if (key.name === 's') {
      notice = null;
      draft.status = 'in_progress';
      render();
      return;
    }

    if (key.name === 'r') {
      if (!hasResultViewer) {
        notice = 'No dispatch result available yet.';
        render();
        return;
      }
      notice = null;
      mode = 'result';
      resultScrollOffset = 0;
      render();
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      void (async () => {
        try {
          await applyFieldEnter();
          if (!restored) {
            render();
          }
        } catch (error) {
          fail(error);
        }
      })();
    }
  };

  return new Promise<TuiJobEditResult>((resolve, reject) => {
    finish = (result: TuiJobEditResult) => {
      restore();
      resolve(result);
    };

    fail = (error: unknown) => {
      restore();
      reject(error);
    };

    for (const listener of lineListeners) {
      rl.off('line', listener);
    }
    for (const listener of sigintListeners) {
      rl.off('SIGINT', listener);
    }
    rl.on('SIGINT', handleSigint);
    input.on('keypress', handleKeypress);
    output.on('resize', render);
    output.write(ENTER_ALT_SCREEN);
    render();
  });
}
