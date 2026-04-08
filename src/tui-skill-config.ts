import readline from 'node:readline';
import {
  SKILL_CONFIG_CHANNEL_KINDS,
  type SkillConfigChannelKind,
} from './channels/channel.js';
import type {
  GatewayAdminSkill,
  GatewayAdminSkillsResponse,
} from './gateway/gateway-types.js';
import { normalizeTrimmedStringSet } from './utils/normalized-strings.js';

export type TuiSkillConfigScope = 'global' | SkillConfigChannelKind;

export const TUI_SKILL_CONFIG_SCOPES = [
  'global',
  ...SKILL_CONFIG_CHANNEL_KINDS,
] as const satisfies readonly TuiSkillConfigScope[];

export interface TuiSkillConfigPalette {
  reset: string;
  bold: string;
  muted: string;
  teal: string;
  gold: string;
  green: string;
  red: string;
}

export const DEFAULT_TUI_SKILL_CONFIG_PALETTE: Readonly<TuiSkillConfigPalette> =
  Object.freeze({
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    muted: '\x1b[90m',
    teal: '\x1b[36m',
    gold: '\x1b[33m',
    green: '\x1b[32m',
    red: '\x1b[31m',
  });

export interface TuiSkillConfigDraft {
  disabled: Set<string>;
  channelDisabled: Partial<Record<SkillConfigChannelKind, Set<string>>>;
}

export interface TuiSkillConfigMutation {
  name: string;
  enabled: boolean;
  channel?: SkillConfigChannelKind;
}

export interface TuiSkillConfigResult {
  cancelled: boolean;
  savedCount: number;
  changedScopeCount: number;
}

interface InternalReadline extends readline.Interface {
  line: string;
  cursor: number;
  _refreshLine?: () => void;
}

interface TuiSkillConfigInput {
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

function resolveTuiSkillConfigPalette(
  palette?: Partial<TuiSkillConfigPalette>,
): TuiSkillConfigPalette {
  return {
    ...DEFAULT_TUI_SKILL_CONFIG_PALETTE,
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

export function getTuiSkillConfigChannel(
  scope: TuiSkillConfigScope,
): SkillConfigChannelKind | undefined {
  return scope === 'global' ? undefined : scope;
}

export function createTuiSkillConfigDraft(
  response: GatewayAdminSkillsResponse,
): TuiSkillConfigDraft {
  return {
    disabled: normalizeTrimmedStringSet(response.disabled),
    channelDisabled: {
      discord: normalizeTrimmedStringSet(response.channelDisabled.discord),
      msteams: normalizeTrimmedStringSet(response.channelDisabled.msteams),
      whatsapp: normalizeTrimmedStringSet(response.channelDisabled.whatsapp),
      email: normalizeTrimmedStringSet(response.channelDisabled.email),
    },
  };
}

export function getTuiSkillScopeDisabledNames(
  draft: TuiSkillConfigDraft,
  scope: TuiSkillConfigScope,
): Set<string> {
  const channel = getTuiSkillConfigChannel(scope);
  return channel
    ? (draft.channelDisabled[channel] ?? new Set())
    : draft.disabled;
}

export function isTuiSkillEnabledInScope(
  draft: TuiSkillConfigDraft,
  skillName: string,
  scope: TuiSkillConfigScope,
): boolean {
  return !getTuiSkillScopeDisabledNames(draft, scope).has(skillName);
}

export function setTuiSkillEnabledInScope(
  draft: TuiSkillConfigDraft,
  skillName: string,
  enabled: boolean,
  scope: TuiSkillConfigScope,
): void {
  const channel = getTuiSkillConfigChannel(scope);
  let disabled = draft.disabled;
  if (channel) {
    if (!draft.channelDisabled[channel]) {
      draft.channelDisabled[channel] = new Set();
    }
    disabled = draft.channelDisabled[channel];
  }
  if (enabled) {
    disabled.delete(skillName);
  } else {
    disabled.add(skillName);
  }
}

export function collectTuiSkillConfigMutations(
  response: GatewayAdminSkillsResponse,
  draft: TuiSkillConfigDraft,
): TuiSkillConfigMutation[] {
  const skills = response.skills.map((skill) => skill.name);
  const mutations: TuiSkillConfigMutation[] = [];

  for (const scope of TUI_SKILL_CONFIG_SCOPES) {
    const channel = getTuiSkillConfigChannel(scope);
    const initialDisabled = channel
      ? normalizeTrimmedStringSet(response.channelDisabled[channel])
      : normalizeTrimmedStringSet(response.disabled);
    const nextDisabled = getTuiSkillScopeDisabledNames(draft, scope);

    for (const skillName of skills) {
      const initiallyEnabled = !initialDisabled.has(skillName);
      const nextEnabled = !nextDisabled.has(skillName);
      if (initiallyEnabled === nextEnabled) continue;
      mutations.push({
        name: skillName,
        enabled: nextEnabled,
        channel,
      });
    }
  }

  return mutations;
}

function countChangedScopes(mutations: TuiSkillConfigMutation[]): number {
  return new Set(mutations.map((mutation) => mutation.channel ?? 'global'))
    .size;
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

  if (width === 1) {
    return hasAnsi ? `${output}\x1b[0m` : output;
  }
  return hasAnsi ? `${output}…\x1b[0m` : `${output}…`;
}

function scopeTab(
  scope: TuiSkillConfigScope,
  active: boolean,
  palette: TuiSkillConfigPalette,
): string {
  if (!active) return `${palette.muted}${scope}${palette.reset}`;
  return `${palette.bold}${palette.gold}[${scope}]${palette.reset}`;
}

function visibleScopeTabLength(
  scope: TuiSkillConfigScope,
  active: boolean,
): number {
  return active ? scope.length + 2 : scope.length;
}

function buildScopeLines(
  scope: TuiSkillConfigScope,
  palette: TuiSkillConfigPalette,
  width: number,
): string[] {
  const prefix = `  ${palette.muted}Scopes:${palette.reset} `;
  const prefixVisibleLength = 10;
  const continuation = '          ';
  const continuationVisibleLength = continuation.length;
  const lines: string[] = [];
  let currentLine = prefix;
  let currentVisibleLength = prefixVisibleLength;
  let lineStartVisibleLength = prefixVisibleLength;

  for (const item of TUI_SKILL_CONFIG_SCOPES) {
    const active = item === scope;
    const tab = scopeTab(item, active, palette);
    const tabVisibleLength = visibleScopeTabLength(item, active);
    const separatorVisibleLength =
      currentVisibleLength > lineStartVisibleLength ? 2 : 0;
    if (
      currentVisibleLength + separatorVisibleLength + tabVisibleLength >
        width &&
      currentVisibleLength > lineStartVisibleLength
    ) {
      lines.push(currentLine);
      currentLine = continuation;
      currentVisibleLength = continuationVisibleLength;
      lineStartVisibleLength = continuationVisibleLength;
    }
    if (currentVisibleLength > lineStartVisibleLength) {
      currentLine += '  ';
      currentVisibleLength += 2;
    }
    currentLine += tab;
    currentVisibleLength += tabVisibleLength;
  }

  lines.push(currentLine);
  return lines.map((line) => truncateLine(line, width));
}

function skillNotes(
  skill: GatewayAdminSkill,
  draft: TuiSkillConfigDraft,
  scope: TuiSkillConfigScope,
): string {
  const notes: string[] = [skill.category];
  if (scope !== 'global' && draft.disabled.has(skill.name)) {
    notes.push('global disable still applies');
  }
  if (!skill.available) {
    notes.push(
      `missing: ${skill.missing.length > 0 ? skill.missing.join(', ') : 'requirements'}`,
    );
  }
  if (skill.always) {
    notes.push('always');
  }
  return notes.join(' · ');
}

export function renderTuiSkillConfigLines(params: {
  response: GatewayAdminSkillsResponse;
  draft: TuiSkillConfigDraft;
  scope: TuiSkillConfigScope;
  cursor: number;
  scrollOffset: number;
  width: number;
  height: number;
  palette?: Partial<TuiSkillConfigPalette>;
  saving?: boolean;
}): { lines: string[]; scrollOffset: number } {
  const {
    response,
    draft,
    scope,
    cursor,
    width,
    height,
    saving = false,
  } = params;
  const palette = resolveTuiSkillConfigPalette(params.palette);
  const safeWidth = Math.max(20, width);
  const scopeLines = buildScopeLines(scope, palette, safeWidth);
  const headerLines = 4 + scopeLines.length;
  const footerLines = 2;
  const visibleRows = Math.max(1, height - headerLines - footerLines);
  let scrollOffset = Math.max(0, params.scrollOffset);

  if (cursor < scrollOffset) {
    scrollOffset = cursor;
  } else if (cursor >= scrollOffset + visibleRows) {
    scrollOffset = cursor - visibleRows + 1;
  }

  const skills = response.skills;
  const currentDisabled = getTuiSkillScopeDisabledNames(draft, scope);
  const mutations = collectTuiSkillConfigMutations(response, draft);
  const selectedSkill = skills[cursor];
  const lines = [
    truncateLine(
      `  ${palette.bold}${palette.gold}Skill Config${palette.reset}`,
      safeWidth,
    ),
    ...scopeLines,
    truncateLine(
      `  ${palette.muted}${saving ? 'Saving changes...' : '↑↓ move  ←→ scope  SPACE toggle  ENTER save  ESC cancel'}${palette.reset}`,
      safeWidth,
    ),
    truncateLine(
      `  ${palette.muted}Checked = enabled in the selected scope. Global disables still apply inside channel scopes.${palette.reset}`,
      safeWidth,
    ),
    truncateLine(
      `  ${palette.teal}${scope}${palette.reset} scope: ${skills.length - currentDisabled.size} enabled, ${currentDisabled.size} disabled${mutations.length > 0 ? ` ${palette.muted}|${palette.reset} ${palette.gold}${mutations.length} unsaved${palette.reset}` : ''}`,
      safeWidth,
    ),
  ];

  for (const [visibleIndex, skill] of skills
    .slice(scrollOffset, scrollOffset + visibleRows)
    .entries()) {
    const index = scrollOffset + visibleIndex;
    const active = index === cursor;
    const enabled = isTuiSkillEnabledInScope(draft, skill.name, scope);
    const arrow = active
      ? `${palette.gold}→${palette.reset}`
      : `${palette.muted} ${palette.reset}`;
    const checkbox = enabled
      ? `${palette.green}[x]${palette.reset}`
      : `${palette.red}[ ]${palette.reset}`;
    const notes = skillNotes(skill, draft, scope);
    lines.push(
      truncateLine(
        ` ${arrow} ${checkbox} ${skill.name}${notes ? ` ${palette.muted}— ${notes}${palette.reset}` : ''}`,
        safeWidth,
      ),
    );
  }

  if (selectedSkill) {
    const footerNotes = [
      selectedSkill.description || 'No description.',
      selectedSkill.category ? `category: ${selectedSkill.category}` : '',
      selectedSkill.source ? `source: ${selectedSkill.source}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(
      truncateLine(
        `  ${palette.bold}${selectedSkill.name}${palette.reset} ${palette.muted}— ${footerNotes}${palette.reset}`,
        safeWidth,
      ),
    );
  } else {
    lines.push(
      truncateLine(
        `  ${palette.muted}No skills found.${palette.reset}`,
        safeWidth,
      ),
    );
  }

  const rangeStart = skills.length === 0 ? 0 : scrollOffset + 1;
  const rangeEnd = Math.min(skills.length, scrollOffset + visibleRows);
  lines.push(
    truncateLine(
      `  ${palette.muted}Showing ${rangeStart}-${rangeEnd} of ${skills.length}${palette.reset}`,
      safeWidth,
    ),
  );

  return {
    lines,
    scrollOffset,
  };
}

export async function promptTuiSkillConfig(params: {
  rl: readline.Interface;
  response: GatewayAdminSkillsResponse;
  saveMutation: (mutation: TuiSkillConfigMutation) => Promise<unknown>;
  palette?: Partial<TuiSkillConfigPalette>;
  output?: NodeJS.WriteStream;
  input?: TuiSkillConfigInput;
}): Promise<TuiSkillConfigResult> {
  const { rl, response, saveMutation } = params;
  const palette = resolveTuiSkillConfigPalette(params.palette);
  const output = params.output || process.stdout;
  const input = params.input || (process.stdin as TuiSkillConfigInput);
  const internal = rl as InternalReadline;
  const draft = createTuiSkillConfigDraft(response);
  const skills = response.skills;

  if (!output.isTTY || input.isTTY === false) {
    return {
      cancelled: false,
      savedCount: 0,
      changedScopeCount: 0,
    };
  }

  const savedLine = internal.line;
  const savedCursor = internal.cursor;
  const lineListeners = rl.listeners('line') as Array<(line: string) => void>;
  const sigintListeners = rl.listeners('SIGINT') as Array<() => void>;
  let renderedLineCount = 0;
  let cursor = 0;
  let scopeIndex = 0;
  let scrollOffset = 0;
  let saving = false;
  let restored = false;
  let finish = (_result: TuiSkillConfigResult) => {};
  let fail = (_error: unknown) => {};

  const clear = () => {
    if (renderedLineCount <= 0) return;
    readline.moveCursor(output, 0, -(renderedLineCount - 1));
    readline.cursorTo(output, 0);
    readline.clearScreenDown(output);
    renderedLineCount = 0;
  };

  const render = () => {
    clear();
    const rendered = renderTuiSkillConfigLines({
      response,
      draft,
      scope: TUI_SKILL_CONFIG_SCOPES[scopeIndex] ?? 'global',
      cursor,
      scrollOffset,
      width: output.columns || 80,
      height: output.rows || 24,
      palette,
      saving,
    });
    scrollOffset = rendered.scrollOffset;
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

  const handleSigint = () => {
    finish({
      cancelled: true,
      savedCount: 0,
      changedScopeCount: 0,
    });
  };

  const handleKeypress = (_chunk: string, key: readline.Key) => {
    if (saving) return;

    const scope = TUI_SKILL_CONFIG_SCOPES[scopeIndex] ?? 'global';

    if (key.ctrl === true && key.name === 'c') {
      finish({
        cancelled: true,
        savedCount: 0,
        changedScopeCount: 0,
      });
      return;
    }

    if (key.name === 'escape' || key.name === 'q') {
      finish({
        cancelled: true,
        savedCount: 0,
        changedScopeCount: 0,
      });
      return;
    }

    if (key.name === 'left' || key.name === 'h') {
      scopeIndex =
        (scopeIndex - 1 + TUI_SKILL_CONFIG_SCOPES.length) %
        TUI_SKILL_CONFIG_SCOPES.length;
      render();
      return;
    }

    if (key.name === 'right' || key.name === 'l') {
      scopeIndex = (scopeIndex + 1) % TUI_SKILL_CONFIG_SCOPES.length;
      render();
      return;
    }

    if (key.name === 'up' || key.name === 'k') {
      cursor = (cursor - 1 + skills.length) % Math.max(1, skills.length);
      render();
      return;
    }

    if (key.name === 'down' || key.name === 'j') {
      cursor = (cursor + 1) % Math.max(1, skills.length);
      render();
      return;
    }

    if (key.name === 'space') {
      const selected = skills[cursor];
      if (!selected) return;
      const enabled = isTuiSkillEnabledInScope(draft, selected.name, scope);
      setTuiSkillEnabledInScope(draft, selected.name, !enabled, scope);
      render();
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      const mutations = collectTuiSkillConfigMutations(response, draft);
      if (mutations.length === 0) {
        finish({
          cancelled: false,
          savedCount: 0,
          changedScopeCount: 0,
        });
        return;
      }

      saving = true;
      render();
      void (async () => {
        try {
          for (const mutation of mutations) {
            await saveMutation(mutation);
          }
          finish({
            cancelled: false,
            savedCount: mutations.length,
            changedScopeCount: countChangedScopes(mutations),
          });
        } catch (error) {
          fail(error);
        }
      })();
    }
  };

  return new Promise<TuiSkillConfigResult>((resolve, reject) => {
    finish = (result: TuiSkillConfigResult) => {
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
    render();
  });
}
