import readline from 'node:readline';

import type { ApprovalScopeMode } from './approval-commands.js';
import type { TuiApprovalDetails } from './tui-approval.js';
import { wrapTuiBlock } from './tui-thinking.js';

export type TuiApprovalSelectionOption = ApprovalScopeMode | 'skip';

export type TuiApprovalPromptResult =
  | { kind: 'select'; option: TuiApprovalSelectionOption }
  | { kind: 'amend' }
  | { kind: 'explain' };

export interface TuiApprovalPromptPalette {
  reset: string;
  bold: string;
  muted: string;
  teal: string;
  gold: string;
  green: string;
  red: string;
}

export const DEFAULT_TUI_APPROVAL_PROMPT_PALETTE: Readonly<TuiApprovalPromptPalette> =
  Object.freeze({
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    muted: '\x1b[90m',
    teal: '\x1b[36m',
    gold: '\x1b[33m',
    green: '\x1b[32m',
    red: '\x1b[31m',
  });

type InternalReadline = readline.Interface & {
  line: string;
  cursor: number;
  _refreshLine?: () => void;
  _ttyWrite?: (chunk: string, key: readline.Key) => void;
};

function resolveTuiApprovalPromptPalette(
  palette?: Partial<TuiApprovalPromptPalette>,
): TuiApprovalPromptPalette {
  return {
    ...DEFAULT_TUI_APPROVAL_PROMPT_PALETTE,
    ...palette,
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

  const targetVisibleLength = width === 1 ? 1 : width - 3;
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

  return hasAnsi
    ? `${output}...${DEFAULT_TUI_APPROVAL_PROMPT_PALETTE.reset}`
    : `${output}...`;
}

function sentenceCase(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function wrapPlainLines(text: string, width: number, indent = '  '): string[] {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  return wrapTuiBlock(normalized, Math.max(20, width), indent).split('\n');
}

function extractIntentPreview(intent: string): string | null {
  const match = /`([^`]+)`/.exec(intent);
  const preview = match?.[1]?.trim();
  return preview || null;
}

function resolveIntentKindLabel(intent: string): string {
  const normalized = intent.trim().toLowerCase();
  if (
    normalized.startsWith('run shell command ') ||
    normalized.startsWith('run mutating command ') ||
    normalized.startsWith('run read-only command ') ||
    normalized.startsWith('run `') ||
    normalized.startsWith('install dependencies with ')
  ) {
    return 'Bash command';
  }
  if (normalized.startsWith('run script ')) {
    return 'Script execution';
  }
  if (normalized.startsWith('control a local app')) {
    return 'Host action';
  }
  if (
    normalized.startsWith('contact new host ') ||
    normalized.startsWith('access ') ||
    normalized.startsWith('contact ') ||
    normalized.startsWith('fetch ')
  ) {
    return 'Network request';
  }
  if (normalized.startsWith('install python packages ')) {
    return 'Python packages';
  }
  if (normalized.startsWith('install ')) {
    return 'Dependency install';
  }
  return 'Approval request';
}

function resolveIntentSummary(intent: string, preview: string | null): string {
  const normalized = intent.trim();
  if (!normalized) return 'Approval required';
  const lower = normalized.toLowerCase();
  if (preview && lower.startsWith('run shell command ')) {
    return 'Run shell command';
  }
  if (preview && lower.startsWith('run mutating command ')) {
    return 'Run mutating command';
  }
  if (preview && lower.startsWith('run read-only command ')) {
    return 'Run read-only command';
  }
  if (preview && lower.startsWith('run script ')) {
    return 'Run script';
  }
  if (preview && lower.startsWith('control a local app with ')) {
    return 'Control a local app';
  }
  if (preview && lower.startsWith('install dependencies with ')) {
    return 'Install dependencies';
  }
  return sentenceCase(normalized);
}

function formatApprovalOptionLabel(option: TuiApprovalSelectionOption): string {
  if (option === 'once') return 'Yes';
  if (option === 'session') return 'Yes for session';
  if (option === 'agent') return 'Yes for agent';
  if (option === 'all') return 'Yes for all';
  return 'No';
}

export function buildTuiApprovalSelectionOptions(params: {
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
}): TuiApprovalSelectionOption[] {
  const options: TuiApprovalSelectionOption[] = ['once'];
  if (params.allowSession) options.push('session');
  if (params.allowAgent) options.push('agent');
  if (params.allowAll) options.push('all');
  options.push('skip');
  return options;
}

export function buildTuiApprovalFollowupDraft(params: {
  kind: 'amend' | 'explain';
  approval: Pick<TuiApprovalDetails, 'intent' | 'reason'>;
}): string {
  const intent = params.approval.intent.trim();
  if (params.kind === 'amend') {
    if (intent) {
      return `Please avoid this action if possible: ${intent}. Use a safer alternative.`;
    }
    return 'Please avoid the approval-required action if possible and use a safer alternative.';
  }
  if (intent) {
    return `Explain why this action is needed: ${intent}. What lower-risk alternatives did you consider?`;
  }
  if (params.approval.reason.trim()) {
    return `Explain why this approval is needed given: ${params.approval.reason.trim()}`;
  }
  return 'Explain why this approval is needed and what lower-risk alternatives you considered.';
}

export function renderTuiApprovalPromptLines(params: {
  approval: Pick<TuiApprovalDetails, 'approvalId' | 'intent' | 'reason'>;
  options: TuiApprovalSelectionOption[];
  cursor: number;
  width: number;
  palette?: Partial<TuiApprovalPromptPalette>;
}): string[] {
  const palette = resolveTuiApprovalPromptPalette(params.palette);
  const safeWidth = Math.max(20, params.width);
  const maxIndex = Math.max(0, params.options.length - 1);
  const cursor = Math.max(0, Math.min(params.cursor, maxIndex));
  const preview = extractIntentPreview(params.approval.intent);
  const kindLabel = resolveIntentKindLabel(params.approval.intent);
  const summary = resolveIntentSummary(params.approval.intent, preview);
  const lines = [
    truncateLine(
      `  ${palette.bold}${palette.gold}Approval required${palette.reset}`,
      safeWidth,
    ),
    '',
  ];

  for (const line of wrapPlainLines(kindLabel, safeWidth, '  ')) {
    lines.push(`${palette.bold}${palette.muted}${line}${palette.reset}`);
  }
  if (preview) {
    for (const line of wrapPlainLines(preview, safeWidth, '   ')) {
      lines.push(`${palette.bold}${palette.teal}${line}${palette.reset}`);
    }
  }
  for (const line of wrapPlainLines(summary, safeWidth, '  ')) {
    lines.push(`${palette.muted}${line}${palette.reset}`);
  }

  lines.push('');
  for (const line of wrapPlainLines(
    `Why: ${params.approval.reason}`,
    safeWidth,
    '  ',
  )) {
    lines.push(line);
  }
  lines.push('');
  lines.push(
    truncateLine(
      `  ${palette.bold}Do you want to proceed?${palette.reset}`,
      safeWidth,
    ),
  );

  for (const [index, option] of params.options.entries()) {
    const active = index === cursor;
    const pointer = active
      ? `${palette.bold}${palette.gold}>${palette.reset}`
      : ' ';
    const optionColor =
      option === 'skip'
        ? palette.red
        : active
          ? `${palette.bold}${palette.green}`
          : palette.reset;
    const number = `${index + 1}.`;
    lines.push(
      truncateLine(
        ` ${pointer} ${number} ${optionColor}${formatApprovalOptionLabel(option)}${palette.reset}`,
        safeWidth,
      ),
    );
  }

  lines.push('');
  for (const line of wrapPlainLines(
    'Esc to cancel | Tab to amend | Ctrl-E to explain',
    safeWidth,
    '  ',
  )) {
    lines.push(`${palette.muted}${line}${palette.reset}`);
  }

  return lines;
}

export async function promptTuiApprovalSelection(params: {
  rl: readline.Interface;
  approval: Pick<TuiApprovalDetails, 'approvalId' | 'intent' | 'reason'>;
  options: TuiApprovalSelectionOption[];
  palette?: Partial<TuiApprovalPromptPalette>;
  output?: NodeJS.WriteStream;
  initialCursor?: number;
}): Promise<TuiApprovalPromptResult | undefined> {
  const { rl, options } = params;
  const palette = resolveTuiApprovalPromptPalette(params.palette);
  const output = params.output || process.stdout;
  const internal = rl as InternalReadline;
  const originalTtyWrite = internal._ttyWrite;

  if (!output.isTTY || !originalTtyWrite || options.length === 0) {
    return undefined;
  }

  const savedLine = internal.line;
  const savedCursor = internal.cursor;
  let renderedLineCount = 0;
  let restored = false;
  let cursor = Math.max(
    0,
    Math.min(params.initialCursor ?? 0, options.length - 1),
  );
  let finish = (_value: TuiApprovalPromptResult) => {};
  const closeHandler = () => {
    finish({ kind: 'select', option: 'skip' });
  };

  const clear = () => {
    if (renderedLineCount <= 0) return;
    readline.moveCursor(output, 0, -(renderedLineCount - 1));
    readline.cursorTo(output, 0);
    readline.clearScreenDown(output);
    renderedLineCount = 0;
  };

  const render = () => {
    clear();
    output.write('\x1b[?25l');
    const lines = renderTuiApprovalPromptLines({
      approval: params.approval,
      options,
      cursor,
      width: output.columns || 80,
      palette,
    });
    output.write(lines.join('\n'));
    renderedLineCount = lines.length;
  };

  const restore = () => {
    if (restored) return;
    restored = true;
    clear();
    output.write('\x1b[?25h');
    if (internal._ttyWrite === handleTtyWrite) {
      internal._ttyWrite = originalTtyWrite;
    }
    output.off('resize', render);
    rl.off('close', closeHandler);
    internal.line = savedLine;
    internal.cursor = Math.min(savedCursor, savedLine.length);
    if (internal._refreshLine) {
      internal._refreshLine();
    } else if (typeof rl.prompt === 'function') {
      rl.prompt(true);
    }
  };

  const selectIndex = (index: number) => {
    const selected = options[index];
    if (!selected) return;
    finish({ kind: 'select', option: selected });
  };

  const handleTtyWrite = (chunk: string, key: readline.Key) => {
    const raw = String(key.sequence ?? chunk ?? '').trim();

    if (key.ctrl === true && key.name === 'e') {
      finish({ kind: 'explain' });
      return;
    }

    if (key.ctrl === true && key.name === 'c') {
      finish({ kind: 'select', option: 'skip' });
      return;
    }

    if (key.name === 'tab') {
      finish({ kind: 'amend' });
      return;
    }

    if (key.name === 'escape' || key.name === 'q' || key.name === 'n') {
      finish({ kind: 'select', option: 'skip' });
      return;
    }

    if (key.name === 'up' || key.name === 'k') {
      cursor = (cursor - 1 + options.length) % options.length;
      render();
      return;
    }

    if (key.name === 'down' || key.name === 'j') {
      cursor = (cursor + 1) % options.length;
      render();
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      selectIndex(cursor);
      return;
    }

    if (key.name === 'y') {
      finish({ kind: 'select', option: 'once' });
      return;
    }

    if (/^\d$/u.test(raw)) {
      const index = Number.parseInt(raw, 10) - 1;
      if (Number.isFinite(index) && index >= 0 && index < options.length) {
        selectIndex(index);
      }
    }
  };

  return new Promise<TuiApprovalPromptResult>((resolve) => {
    finish = (value: TuiApprovalPromptResult) => {
      restore();
      resolve(value);
    };

    internal._ttyWrite = handleTtyWrite;
    output.on('resize', render);
    rl.on('close', closeHandler);
    render();
  });
}
