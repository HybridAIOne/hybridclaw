import readline from 'node:readline';

import type { ApprovalScopeMode } from './approval-commands.js';
import type { TuiApprovalDetails } from './tui-approval.js';
import { wrapTuiBlock } from './tui-thinking.js';

export type TuiApprovalSelectionOption = ApprovalScopeMode | 'skip';

const TUI_APPROVAL_PROMPT_PALETTE = Object.freeze({
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  muted: '\x1b[90m',
  teal: '\x1b[36m',
  gold: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
});

// biome-ignore lint/complexity/useRegexLiterals: the literal form trips noControlCharactersInRegex for these ANSI escape-code ranges.
const TERMINAL_ESCAPE_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
);
const ALLOWED_SGR_PATTERN = /^\x1b\[[0-9;]*m$/u;
// Keep tabs/newlines alone here; the render path only needs to strip control
// bytes that can mutate the terminal state or cursor position.
const DISALLOWED_TERMINAL_CONTROL_PATTERN =
  /[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F\u009B]/g;

type InternalReadline = readline.Interface & {
  line: string;
  cursor: number;
  _refreshLine?: () => void;
};

interface TuiApprovalPromptInput {
  isTTY?: boolean;
  on(
    event: 'keypress',
    listener: (chunk: string, key: readline.Key) => void,
  ): this;
  off(
    event: 'keypress',
    listener: (chunk: string, key: readline.Key) => void,
  ): this;
};

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

function truncateLine(value: string, width: number, reset = ''): string {
  if (width <= 0) return '';
  const targetVisibleLength = width === 1 ? 1 : width - 3;
  let output = '';
  let visibleLength = 0;
  let truncated = false;
  const hasAnsi = value.includes('\x1b[');

  for (let index = 0; index < value.length; ) {
    const ansiSequenceLength = getAnsiSequenceLength(value, index);
    if (ansiSequenceLength > 0) {
      output += value.slice(index, index + ansiSequenceLength);
      index += ansiSequenceLength;
      continue;
    }

    if (visibleLength >= targetVisibleLength) {
      truncated = true;
      break;
    }

    output += value[index] || '';
    visibleLength += 1;
    index += 1;
  }

  if (!truncated) return output;

  return hasAnsi ? `${output}...${reset}` : `${output}...`;
}

function sentenceCase(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function sanitizeTerminalText(value: string): string {
  return String(value || '')
    .replace(TERMINAL_ESCAPE_PATTERN, (sequence) =>
      ALLOWED_SGR_PATTERN.test(sequence) ? sequence : '',
    )
    .replace(DISALLOWED_TERMINAL_CONTROL_PATTERN, '');
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

function resolveIntentPresentation(
  intent: string,
  preview: string | null,
): { kindLabel: string; summary: string } {
  const normalized = intent.trim();
  if (!normalized) {
    return {
      kindLabel: 'Approval request',
      summary: 'Approval required',
    };
  }

  const lower = normalized.toLowerCase();
  if (
    lower.startsWith('run shell command ') ||
    lower.startsWith('run mutating command ') ||
    lower.startsWith('run read-only command ') ||
    lower.startsWith('run `') ||
    lower.startsWith('install dependencies with ')
  ) {
    let summary = sentenceCase(normalized);
    if (preview && lower.startsWith('run shell command ')) {
      summary = 'Run shell command';
    } else if (preview && lower.startsWith('run mutating command ')) {
      summary = 'Run mutating command';
    } else if (preview && lower.startsWith('run read-only command ')) {
      summary = 'Run read-only command';
    } else if (preview && lower.startsWith('install dependencies with ')) {
      summary = 'Install dependencies';
    }
    return {
      kindLabel: 'Bash command',
      summary,
    };
  }

  if (lower.startsWith('run script ')) {
    return {
      kindLabel: 'Script execution',
      summary: preview ? 'Run script' : sentenceCase(normalized),
    };
  }

  if (lower.startsWith('control a local app')) {
    return {
      kindLabel: 'Host action',
      summary:
        preview && lower.startsWith('control a local app with ')
          ? 'Control a local app'
          : sentenceCase(normalized),
    };
  }
  if (
    lower.startsWith('contact new host ') ||
    lower.startsWith('access ') ||
    lower.startsWith('contact ') ||
    lower.startsWith('fetch ')
  ) {
    return {
      kindLabel: 'Network request',
      summary: sentenceCase(normalized),
    };
  }
  if (lower.startsWith('install python packages ')) {
    return {
      kindLabel: 'Python packages',
      summary: sentenceCase(normalized),
    };
  }
  if (lower.startsWith('install ')) {
    return {
      kindLabel: 'Dependency install',
      summary: sentenceCase(normalized),
    };
  }

  return {
    kindLabel: 'Approval request',
    summary: sentenceCase(normalized),
  };
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

export function renderTuiApprovalPromptLines(params: {
  approval: Pick<TuiApprovalDetails, 'approvalId' | 'intent' | 'reason'>;
  options: TuiApprovalSelectionOption[];
  cursor: number;
  width: number;
}): string[] {
  const palette = TUI_APPROVAL_PROMPT_PALETTE;
  const safeWidth = Math.max(20, params.width);
  const maxIndex = Math.max(0, params.options.length - 1);
  const cursor = Math.max(0, Math.min(params.cursor, maxIndex));
  const intent = sanitizeTerminalText(params.approval.intent);
  const reason = sanitizeTerminalText(params.approval.reason);
  const preview = extractIntentPreview(intent);
  const { kindLabel, summary } = resolveIntentPresentation(
    intent,
    preview,
  );
  const lines = [
    truncateLine(
      `  ${palette.bold}${palette.gold}Approval required${palette.reset}`,
      safeWidth,
      palette.reset,
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
    `Why: ${reason}`,
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
      palette.reset,
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
        palette.reset,
      ),
    );
  }

  lines.push('');
  for (const line of wrapPlainLines('Esc to skip', safeWidth, '  ')) {
    lines.push(`${palette.muted}${line}${palette.reset}`);
  }

  return lines;
}

export async function promptTuiApprovalSelection(params: {
  rl: readline.Interface;
  approval: Pick<TuiApprovalDetails, 'approvalId' | 'intent' | 'reason'>;
  options: TuiApprovalSelectionOption[];
  input?: TuiApprovalPromptInput;
  output?: NodeJS.WriteStream;
  initialCursor?: number;
  restorePrompt?: boolean;
}): Promise<TuiApprovalSelectionOption | undefined> {
  const { rl, options } = params;
  const input = params.input || process.stdin;
  const output = params.output || process.stdout;
  const internal = rl as InternalReadline;

  if (options.length === 0) {
    throw new Error('TUI approval prompt requires at least one option.');
  }

  if (!output.isTTY || !input.isTTY) {
    return undefined;
  }

  const savedLine = internal.line;
  const savedCursor = internal.cursor;
  const lineListeners = rl.listeners('line') as Array<(line: string) => void>;
  const sigintListeners = rl.listeners('SIGINT') as Array<() => void>;
  let renderedLineCount = 0;
  let restored = false;
  let cursor = Math.max(
    0,
    Math.min(params.initialCursor ?? 0, options.length - 1),
  );
  let finish = (_value: TuiApprovalSelectionOption) => {};
  const closeHandler = () => {
    finish('skip');
  };

  const buildClearFrame = () => {
    if (renderedLineCount <= 0) return '';
    return `${renderedLineCount > 1 ? `\x1b[${renderedLineCount - 1}A` : ''}\r\x1b[J`;
  };

  const render = () => {
    const clearFrame = buildClearFrame();
    const lines = renderTuiApprovalPromptLines({
      approval: params.approval,
      options,
      cursor,
      width: output.columns || 80,
    });
    output.write(`${clearFrame}\x1b[?25l${lines.join('\n')}`);
    renderedLineCount = lines.length;
  };

  const restore = () => {
    if (restored) return;
    restored = true;
    output.write(`${buildClearFrame()}\x1b[?25h`);
    renderedLineCount = 0;
    input.off('keypress', handleKeypress);
    output.off('resize', render);
    rl.off('close', closeHandler);
    rl.off('SIGINT', handleSigint);
    for (const listener of lineListeners) {
      rl.on('line', listener);
    }
    for (const listener of sigintListeners) {
      rl.on('SIGINT', listener);
    }
    internal.line = savedLine;
    internal.cursor = Math.min(savedCursor, savedLine.length);
    if (params.restorePrompt !== false) {
      if (internal._refreshLine) {
        internal._refreshLine();
      } else if (typeof rl.prompt === 'function') {
        rl.prompt(true);
      }
    }
  };

  const selectIndex = (index: number) => {
    const selected = options[index];
    if (!selected) return;
    finish(selected);
  };

  const handleSigint = () => {
    finish('skip');
  };

  const handleKeypress = (chunk: string, key: readline.Key) => {
    const raw = String(key.sequence ?? chunk ?? '').trim();

    if (key.ctrl === true && key.name === 'c') {
      finish('skip');
      return;
    }

    if (key.name === 'escape' || key.name === 'q' || key.name === 'n') {
      finish('skip');
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

    if (/^\d$/u.test(raw)) {
      const index = Number.parseInt(raw, 10) - 1;
      if (Number.isFinite(index) && index >= 0 && index < options.length) {
        selectIndex(index);
      }
    }
  };

  return new Promise<TuiApprovalSelectionOption>((resolve) => {
    finish = (value: TuiApprovalSelectionOption) => {
      restore();
      resolve(value);
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
    rl.on('close', closeHandler);
    render();
  });
}
