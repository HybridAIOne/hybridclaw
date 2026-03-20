import readline from 'node:readline';
import type {
  GatewayAdminJob,
  GatewayAdminJobsResponse,
} from '../gateway/gateway-types.js';

type InternalReadline = readline.Interface & {
  line: string;
  cursor: number;
  _refreshLine?: () => void;
};

export interface TuiJobsBoardPalette {
  reset: string;
  bold: string;
  muted: string;
  teal: string;
  gold: string;
  green: string;
  red: string;
  selected: string;
  backlog: string;
  ready: string;
  progress: string;
  blocked: string;
  done: string;
  backlogFill: string;
  readyFill: string;
  progressFill: string;
  blockedFill: string;
  doneFill: string;
}

const DEFAULT_PALETTE: TuiJobsBoardPalette = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  muted: '\x1b[90m',
  teal: '\x1b[36m',
  gold: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  selected: '\x1b[7m',
  backlog: '\x1b[38;2;148;163;184m',
  ready: '\x1b[38;2;45;212;191m',
  progress: '\x1b[38;2;251;191;36m',
  blocked: '\x1b[38;2;248;113;113m',
  done: '\x1b[38;2;74;222;128m',
  backlogFill: '\x1b[48;2;30;41;59m',
  readyFill: '\x1b[48;2;6;78;59m',
  progressFill: '\x1b[48;2;92;56;0m',
  blockedFill: '\x1b[48;2;91;33;33m',
  doneFill: '\x1b[48;2;20;83;45m',
};

const PRIORITY_MARKERS: Record<GatewayAdminJob['priority'], string> = {
  low: '-',
  normal: '•',
  high: '!',
  urgent: '‼',
};

export interface TuiJobsBoardRenderResult {
  lines: string[];
  scrollOffsets: number[];
}

export interface TuiJobsBoardResult {
  cancelled: boolean;
  openedJobId: number | null;
}

function resolvePalette(
  palette?: Partial<TuiJobsBoardPalette>,
): TuiJobsBoardPalette {
  return {
    ...DEFAULT_PALETTE,
    ...(palette || {}),
  };
}

function truncateText(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length <= width) return value.padEnd(width, ' ');
  if (width === 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

function stripAndNormalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatCardLabel(job: GatewayAdminJob, width: number): string {
  const text = `${PRIORITY_MARKERS[job.priority]} #${job.id} ${stripAndNormalize(job.title)}`;
  return truncateText(text, width);
}

function formatDetailText(
  job: GatewayAdminJob | null,
  width: number,
): string[] {
  if (!job) {
    return [
      truncateText('No job selected.', width),
      truncateText('Use arrow keys to move focus. Press Enter to edit.', width),
      ''.padEnd(width, ' '),
      ''.padEnd(width, ' '),
    ];
  }

  const title = truncateText(
    `#${job.id} ${stripAndNormalize(job.title)}`,
    width,
  );
  const meta = truncateText(
    [
      job.status.replace(/_/g, ' '),
      job.priority,
      job.dispatch?.summary ||
        (job.assigneeAgentId
          ? `assignee ${job.assigneeAgentId}`
          : 'unassigned'),
      job.sourceSessionId ? `session ${job.sourceSessionId}` : 'no session',
    ].join(' · '),
    width,
  );
  const details = truncateText(
    stripAndNormalize(job.details) || 'No details.',
    width,
  );
  const updated = truncateText(`Updated ${job.updatedAt}`, width);
  return [title, meta, details, updated];
}

function buildJobsByColumn(
  response: GatewayAdminJobsResponse,
): Array<GatewayAdminJob[]> {
  return response.columns.map((column) =>
    response.jobs
      .filter((job) => !job.archivedAt && job.status === column.id)
      .sort(
        (left, right) =>
          left.lanePosition - right.lanePosition || left.id - right.id,
      ),
  );
}

function resolveVisibleColumnCount(
  totalColumns: number,
  width: number,
): number {
  const gap = 3;
  for (let count = Math.min(totalColumns, 5); count >= 1; count -= 1) {
    const columnWidth = Math.floor((width - gap * (count - 1)) / count);
    if (columnWidth >= 20) return count;
  }
  return 1;
}

function resolveVisibleColumnStart(
  totalColumns: number,
  activeColumnIndex: number,
  visibleColumnCount: number,
): number {
  if (visibleColumnCount >= totalColumns) return 0;
  const maxStart = Math.max(0, totalColumns - visibleColumnCount);
  return Math.max(
    0,
    Math.min(maxStart, activeColumnIndex - Math.floor(visibleColumnCount / 2)),
  );
}

function resolveColumnAccent(
  status: GatewayAdminJob['status'],
  palette: TuiJobsBoardPalette,
): string {
  switch (status) {
    case 'backlog':
      return palette.backlog;
    case 'ready':
      return palette.ready;
    case 'in_progress':
      return palette.progress;
    case 'blocked':
      return palette.blocked;
    case 'done':
      return palette.done;
  }
}

function resolveColumnFill(
  status: GatewayAdminJob['status'],
  palette: TuiJobsBoardPalette,
): string {
  switch (status) {
    case 'backlog':
      return palette.backlogFill;
    case 'ready':
      return palette.readyFill;
    case 'in_progress':
      return palette.progressFill;
    case 'blocked':
      return palette.blockedFill;
    case 'done':
      return palette.doneFill;
  }
}

function padBetween(left: string, right: string, width: number): string {
  if (width <= 0) return '';
  if (left.length + right.length + 1 <= width) {
    return `${left}${' '.repeat(width - left.length - right.length)}${right}`;
  }
  if (width <= right.length) {
    return truncateText(right, width);
  }
  return `${truncateText(left, width - right.length - 1)} ${right}`;
}

export function renderTuiJobsBoardLines(params: {
  response: GatewayAdminJobsResponse;
  activeColumnIndex: number;
  cursors: number[];
  scrollOffsets: number[];
  width: number;
  height: number;
  palette?: Partial<TuiJobsBoardPalette>;
}): TuiJobsBoardRenderResult {
  const palette = resolvePalette(params.palette);
  const width = Math.max(48, params.width || 80);
  const height = Math.max(12, params.height || 24);
  const jobsByColumn = buildJobsByColumn(params.response);
  const visibleColumnCount = resolveVisibleColumnCount(
    params.response.columns.length,
    width,
  );
  const visibleColumnStart = resolveVisibleColumnStart(
    params.response.columns.length,
    params.activeColumnIndex,
    visibleColumnCount,
  );
  const visibleColumns = params.response.columns.slice(
    visibleColumnStart,
    visibleColumnStart + visibleColumnCount,
  );
  const gap = ' │ ';
  const columnWidth = Math.max(
    20,
    Math.floor(
      (width - gap.length * (visibleColumns.length - 1)) /
        visibleColumns.length,
    ),
  );
  const headerRows = 2;
  const detailRows = Math.max(4, height >= 16 ? 6 : 4);
  const bodyRows = Math.max(5, Math.min(8, height - headerRows - detailRows));
  const listRows = Math.max(1, bodyRows - 4);
  const columnInnerWidth = columnWidth - 2;
  const nextScrollOffsets = [...params.scrollOffsets];
  const activeJobs = jobsByColumn[params.activeColumnIndex] || [];
  const activeCursor = Math.max(
    0,
    Math.min(
      params.cursors[params.activeColumnIndex] || 0,
      Math.max(0, activeJobs.length - 1),
    ),
  );
  const maxActiveScroll = Math.max(0, activeJobs.length - listRows);
  let activeScroll = Math.max(
    0,
    Math.min(nextScrollOffsets[params.activeColumnIndex] || 0, maxActiveScroll),
  );
  if (activeCursor < activeScroll) {
    activeScroll = activeCursor;
  } else if (activeCursor >= activeScroll + listRows) {
    activeScroll = activeCursor - listRows + 1;
  }
  nextScrollOffsets[params.activeColumnIndex] = activeScroll;

  const lines: string[] = [];
  const hiddenLaneNote =
    visibleColumns.length < params.response.columns.length
      ? `  lanes ${visibleColumnStart + 1}-${visibleColumnStart + visibleColumns.length} of ${params.response.columns.length}`
      : '';
  lines.push(
    `${palette.bold}${palette.gold}Jobs Board${palette.reset}${palette.muted}${hiddenLaneNote}${palette.reset}`,
  );
  lines.push(
    `${palette.muted}←→ lanes  ↑↓ cards  Enter edit  ESC close${palette.reset}`,
  );

  const renderedColumns = visibleColumns.map((column, visibleIndex) => {
    const actualIndex = visibleColumnStart + visibleIndex;
    const isActiveColumn = actualIndex === params.activeColumnIndex;
    const columnJobs = jobsByColumn[actualIndex] || [];
    const scrollOffset = nextScrollOffsets[actualIndex] || 0;
    const accent = resolveColumnAccent(column.id, palette);
    const fill = resolveColumnFill(column.id, palette);
    const headerText = padBetween(
      `${isActiveColumn ? '◉' : '○'} ${column.label}`,
      `${columnJobs.length}`,
      columnInnerWidth,
    );
    const border = isActiveColumn ? `${palette.bold}${accent}` : accent;
    const top = `${border}╭${'─'.repeat(columnInnerWidth)}╮${palette.reset}`;
    const header = `${border}│${palette.reset}${fill}${isActiveColumn ? palette.bold : ''} ${truncateText(headerText, columnInnerWidth - 2)} ${palette.reset}${border}│${palette.reset}`;
    const separator = `${border}├${'─'.repeat(columnInnerWidth)}┤${palette.reset}`;
    const rows = [top, header, separator];
    for (let rowIndex = 0; rowIndex < listRows; rowIndex += 1) {
      const job = columnJobs[scrollOffset + rowIndex] || null;
      const isSelected =
        isActiveColumn && job && scrollOffset + rowIndex === activeCursor;
      const plain = job
        ? formatCardLabel(job, columnInnerWidth)
        : ''.padEnd(columnInnerWidth, ' ');
      const content = isSelected
        ? `${palette.selected}${plain}${palette.reset}`
        : plain;
      rows.push(
        `${border}│${palette.reset}${content}${border}│${palette.reset}`,
      );
    }
    rows.push(`${border}╰${'─'.repeat(columnInnerWidth)}╯${palette.reset}`);
    return rows;
  });

  for (let rowIndex = 0; rowIndex < bodyRows; rowIndex += 1) {
    lines.push(
      renderedColumns
        .map((column) => column[rowIndex] || ''.padEnd(columnWidth, ' '))
        .join(gap),
    );
  }

  const selectedColumn = params.response.columns[params.activeColumnIndex];
  const selectedAccent = selectedColumn
    ? resolveColumnAccent(selectedColumn.id, palette)
    : palette.muted;
  const detailInnerWidth = Math.max(16, width - 4);
  const detailBorder = `${palette.bold}${selectedAccent}`;
  lines.push(
    `${detailBorder}╭${'─'.repeat(detailInnerWidth + 2)}╮${palette.reset}`,
  );
  const selectedJob = activeJobs[activeCursor] || null;
  const detailLines = formatDetailText(selectedJob, detailInnerWidth);
  const detailContent = detailLines
    .slice(0, Math.max(1, detailRows - 2))
    .concat(
      Array.from({
        length: Math.max(0, detailRows - 2 - detailLines.length),
      }).map(() => ''.padEnd(detailInnerWidth, ' ')),
    );

  for (let index = 0; index < detailContent.length; index += 1) {
    const content = detailContent[index] || ''.padEnd(detailInnerWidth, ' ');
    const rowText =
      index === 0 && selectedJob
        ? `${palette.bold}${selectedAccent}${content}${palette.reset}`
        : index === 1 || index === detailContent.length - 1
          ? `${palette.muted}${content}${palette.reset}`
          : content;
    lines.push(
      `${detailBorder}│${palette.reset} ${rowText} ${detailBorder}│${palette.reset}`,
    );
  }
  lines.push(
    `${detailBorder}╰${'─'.repeat(detailInnerWidth + 2)}╯${palette.reset}`,
  );

  return {
    lines: lines.slice(0, height),
    scrollOffsets: nextScrollOffsets,
  };
}

export async function promptTuiJobsBoard(params: {
  rl: readline.Interface;
  response: GatewayAdminJobsResponse;
  palette?: Partial<TuiJobsBoardPalette>;
  output?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
}): Promise<TuiJobsBoardResult> {
  const { rl, response } = params;
  const output = params.output || process.stdout;
  const input = params.input || process.stdin;
  const palette = resolvePalette(params.palette);
  const internal = rl as InternalReadline;

  if (!output.isTTY || input.isTTY === false) {
    return {
      cancelled: false,
      openedJobId: null,
    };
  }

  const jobsByColumn = buildJobsByColumn(response);
  const firstNonEmptyColumn = Math.max(
    0,
    jobsByColumn.findIndex((jobs) => jobs.length > 0),
  );
  const savedLine = internal.line;
  const savedCursor = internal.cursor;
  const lineListeners = rl.listeners('line') as Array<(line: string) => void>;
  const sigintListeners = rl.listeners('SIGINT') as Array<() => void>;
  let activeColumnIndex = firstNonEmptyColumn === -1 ? 0 : firstNonEmptyColumn;
  const cursors = response.columns.map(() => 0);
  const scrollOffsets = response.columns.map(() => 0);
  let renderedLineCount = 0;
  let restored = false;
  let finish = (_result: TuiJobsBoardResult) => {};

  const clear = () => {
    if (renderedLineCount <= 0) return;
    readline.moveCursor(output, 0, -(renderedLineCount - 1));
    readline.cursorTo(output, 0);
    readline.clearScreenDown(output);
    renderedLineCount = 0;
  };

  const render = () => {
    clear();
    const rendered = renderTuiJobsBoardLines({
      response,
      activeColumnIndex,
      cursors,
      scrollOffsets,
      width: output.columns || 80,
      height: output.rows || 24,
      palette,
    });
    for (let index = 0; index < scrollOffsets.length; index += 1) {
      scrollOffsets[index] = rendered.scrollOffsets[index] || 0;
    }
    output.write('\x1b[?25l');
    output.write(rendered.lines.join('\n'));
    renderedLineCount = rendered.lines.length;
  };

  const restore = () => {
    if (restored) return;
    restored = true;
    clear();
    output.write('\x1b[?25h');
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

  const currentJob = (): GatewayAdminJob | null => {
    const jobs = jobsByColumn[activeColumnIndex] || [];
    return jobs[cursors[activeColumnIndex] || 0] || null;
  };

  const handleSigint = () => {
    finish({
      cancelled: true,
      openedJobId: null,
    });
  };

  const handleKeypress = (_chunk: string, key: readline.Key) => {
    if (key.ctrl === true && key.name === 'c') {
      finish({
        cancelled: true,
        openedJobId: null,
      });
      return;
    }

    if (key.name === 'escape') {
      finish({
        cancelled: true,
        openedJobId: null,
      });
      return;
    }

    if (key.name === 'left') {
      activeColumnIndex =
        (activeColumnIndex - 1 + response.columns.length) %
        Math.max(1, response.columns.length);
      render();
      return;
    }

    if (key.name === 'right') {
      activeColumnIndex =
        (activeColumnIndex + 1) % Math.max(1, response.columns.length);
      render();
      return;
    }

    if (key.name === 'up') {
      const jobs = jobsByColumn[activeColumnIndex] || [];
      if (jobs.length === 0) return;
      cursors[activeColumnIndex] =
        (cursors[activeColumnIndex] - 1 + jobs.length) % jobs.length;
      render();
      return;
    }

    if (key.name === 'down') {
      const jobs = jobsByColumn[activeColumnIndex] || [];
      if (jobs.length === 0) return;
      cursors[activeColumnIndex] =
        (cursors[activeColumnIndex] + 1) % jobs.length;
      render();
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      finish({
        cancelled: false,
        openedJobId: currentJob()?.id || null,
      });
    }
  };

  return new Promise<TuiJobsBoardResult>((resolve) => {
    finish = (result: TuiJobsBoardResult) => {
      restore();
      resolve(result);
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
    render();
  });
}
