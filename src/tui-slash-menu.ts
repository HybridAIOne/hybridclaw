import readline from 'node:readline';

import {
  buildCanonicalSlashCommandDefinitions,
  type CanonicalSlashCommandDefinition,
  type CanonicalSlashStringOptionDefinition,
} from './command-registry.js';
import { renderTuiSlashMenuLines } from './tui-slash-menu-render.js';
import type {
  TuiSlashMenuEntry,
  TuiSlashMenuPalette,
} from './tui-slash-menu-types.js';
export type { TuiSlashMenuEntry, TuiSlashMenuPalette };

interface TuiSlashMenuState {
  query: string;
  entries: TuiSlashMenuEntry[];
}

type InternalReadline = readline.Interface & {
  // The slash menu hooks into Node 22 readline internals (`_ttyWrite`,
  // `_refreshLine`, `line`, `cursor`) because the public API does not expose a
  // way to intercept key handling or replace the active buffer contents
  // without breaking history/navigation behavior. Keep this scoped here and
  // re-verify on Node upgrades.
  line: string;
  cursor: number;
  _refreshLine?: () => void;
  _ttyWrite?: (s: string, key: readline.Key) => void;
};

interface ManualMenuEntrySeed {
  id: string;
  label: string;
  insertText: string;
  description: string;
  aliases?: string[];
  depth?: number;
}

const TOP_LEVEL_ALIASES = new Map<string, string[]>([['help', ['h', '?']]]);

const CHILD_ENTRY_ALIASES = new Map<string, string[]>([
  ['model.clear', ['auto']],
]);

const MANUAL_CHILD_ENTRIES = new Map<string, ManualMenuEntrySeed[]>([
  [
    'model',
    [
      {
        id: 'model.select',
        label: '/model select',
        insertText: '/model select',
        description: 'Open the interactive model selector for this session',
      },
    ],
  ],
  [
    'approve',
    [
      {
        id: 'approve.view',
        label: '/approve view [approval_id]',
        insertText: '/approve view ',
        description:
          'Show the latest pending approval prompt, or a specific request id',
      },
      {
        id: 'approve.yes',
        label: '/approve yes [approval_id]',
        insertText: '/approve yes',
        description: 'Approve the pending request once',
      },
      {
        id: 'approve.session',
        label: '/approve session [approval_id]',
        insertText: '/approve session',
        description: 'Approve the pending request for the rest of the session',
      },
      {
        id: 'approve.agent',
        label: '/approve agent [approval_id]',
        insertText: '/approve agent',
        description:
          'Approve the pending request for the current agent workspace',
      },
      {
        id: 'approve.no',
        label: '/approve no [approval_id]',
        insertText: '/approve no',
        description: 'Deny or skip the pending approval request',
      },
    ],
  ],
  [
    'channel-mode',
    [
      {
        id: 'channel-mode.off',
        label: '/channel-mode off',
        insertText: '/channel-mode off',
        description: 'Disable channel replies until explicitly invoked',
      },
      {
        id: 'channel-mode.mention',
        label: '/channel-mode mention',
        insertText: '/channel-mode mention',
        description: 'Reply only when the assistant is mentioned',
      },
      {
        id: 'channel-mode.free',
        label: '/channel-mode free',
        insertText: '/channel-mode free',
        description: 'Allow free-response mode in the current channel',
      },
    ],
  ],
  [
    'channel-policy',
    [
      {
        id: 'channel-policy.open',
        label: '/channel-policy open',
        insertText: '/channel-policy open',
        description: 'Allow the bot in all channels in the guild',
      },
      {
        id: 'channel-policy.allowlist',
        label: '/channel-policy allowlist',
        insertText: '/channel-policy allowlist',
        description: 'Restrict the bot to approved channels only',
      },
      {
        id: 'channel-policy.disabled',
        label: '/channel-policy disabled',
        insertText: '/channel-policy disabled',
        description: 'Disable guild-wide channel access',
      },
    ],
  ],
  [
    'rag',
    [
      {
        id: 'rag.on',
        label: '/rag on',
        insertText: '/rag on',
        description: 'Enable retrieval-augmented generation for this session',
      },
      {
        id: 'rag.off',
        label: '/rag off',
        insertText: '/rag off',
        description: 'Disable retrieval-augmented generation for this session',
      },
    ],
  ],
  [
    'reset',
    [
      {
        id: 'reset.yes',
        label: '/reset yes',
        insertText: '/reset yes',
        description: 'Confirm a full session reset and remove the workspace',
      },
      {
        id: 'reset.no',
        label: '/reset no',
        insertText: '/reset no',
        description: 'Cancel a pending reset command',
      },
    ],
  ],
  [
    'usage',
    [
      {
        id: 'usage.summary',
        label: '/usage summary',
        insertText: '/usage summary',
        description: 'Show the current usage summary',
      },
      {
        id: 'usage.daily',
        label: '/usage daily',
        insertText: '/usage daily',
        description: 'Show daily usage totals',
      },
      {
        id: 'usage.monthly',
        label: '/usage monthly',
        insertText: '/usage monthly',
        description: 'Show monthly usage totals',
      },
      {
        id: 'usage.model',
        label: '/usage model [daily|monthly] [agent_id]',
        insertText: '/usage model ',
        description:
          'Show per-model usage, optionally scoped to a window and agent id',
      },
    ],
  ],
  [
    'usage.model',
    [
      {
        id: 'usage.model.daily',
        label: '/usage model daily [agent_id]',
        insertText: '/usage model daily ',
        description: 'Show per-model daily usage, optionally filtered by agent',
      },
      {
        id: 'usage.model.monthly',
        label: '/usage model monthly [agent_id]',
        insertText: '/usage model monthly ',
        description:
          'Show per-model monthly usage, optionally filtered by agent',
      },
    ],
  ],
]);

const EXTRA_ROOT_ENTRIES: ManualMenuEntrySeed[] = [
  {
    id: 'bots',
    label: '/bots',
    insertText: '/bots',
    description: 'List available bots for this session',
  },
  {
    id: 'fullauto',
    label: '/fullauto [status|off|on [prompt]|<prompt>]',
    insertText: '/fullauto ',
    description: 'Enable, inspect, disable, or steer session full-auto mode',
  },
  {
    id: 'fullauto.status',
    label: '/fullauto status',
    insertText: '/fullauto status',
    description: 'Show the current full-auto runtime status',
    depth: 2,
  },
  {
    id: 'fullauto.on',
    label: '/fullauto on [prompt]',
    insertText: '/fullauto on ',
    description: 'Enable full-auto, optionally with a custom objective prompt',
    depth: 2,
  },
  {
    id: 'fullauto.off',
    label: '/fullauto off',
    insertText: '/fullauto off',
    description: 'Disable full-auto for the current session',
    depth: 2,
  },
  {
    id: 'info',
    label: '/info',
    insertText: '/info',
    description: 'Show current bot, model, and runtime settings together',
  },
  {
    id: 'stop',
    label: '/stop',
    insertText: '/stop',
    description: 'Interrupt the current request and disable full-auto',
    aliases: ['abort'],
  },
  {
    id: 'exit',
    label: '/exit',
    insertText: '/exit',
    description: 'Quit the TUI',
    aliases: ['quit', 'q'],
  },
];

const MAX_RESULTS = 12;
const SCORE_WEIGHTS = {
  // Match precedence from strongest to weakest:
  // exact normalized > exact compact > prefix normalized > substring normalized
  // > prefix compact > subsequence compact. The base values keep these buckets
  // disjoint so later tuning can adjust one tier without accidentally outranking
  // another.
  exactNormalizedBase: 2200,
  exactCompactBase: 2000,
  prefixNormalizedBase: 1800,
  substringNormalizedBase: 1600,
  prefixCompactBase: 1500,
  subsequenceBase: 1000,
  emptyQueryBase: 1000,
  exactLengthPenalty: 1,
  prefixLengthPenalty: 1,
  substringIndexPenalty: 5,
  subsequenceGapPenalty: 10,
  subsequenceStartPenalty: 2,
  emptyQueryDepthPenalty: 10,
  depthBonusBase: 20,
  depthBonusPenalty: 3,
} as const;

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

function sanitizeLabelForSearch(label: string): string {
  return label.replace(/[<>\[\]"]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isStringOption(
  value: unknown,
): value is CanonicalSlashStringOptionDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind?: unknown }).kind === 'string'
  );
}

function formatOptionToken(option: CanonicalSlashStringOptionDefinition): string {
  const cleanedName = option.name.trim();
  if (
    Array.isArray(option.choices) &&
    option.choices.length > 0 &&
    option.choices.length <= 3
  ) {
    const choices = option.choices.map((choice) => choice.value).join('|');
    return option.required ? `<${choices}>` : `[${choices}]`;
  }
  return option.required ? `<${cleanedName}>` : `[${cleanedName}]`;
}

function formatOptionSuffix(
  options: CanonicalSlashStringOptionDefinition[] | undefined,
): string {
  if (!options || options.length === 0) return '';
  return options.map((option) => formatOptionToken(option)).join(' ');
}

function buildSearchTerms(label: string, aliases: string[] = []): string[] {
  const normalizedLabel = sanitizeLabelForSearch(label);
  const values = new Set<string>([label, normalizedLabel]);
  for (const alias of aliases) {
    const normalizedAlias = alias.trim().replace(/^\/+/, '');
    if (!normalizedAlias) continue;
    values.add(`/${normalizedAlias}`);
    values.add(normalizedAlias);
  }
  return Array.from(values);
}

function createMenuEntry(params: {
  id: string;
  label: string;
  insertText: string;
  description: string;
  aliases?: string[];
  depth: number;
  sortIndex: number;
}): TuiSlashMenuEntry {
  return {
    id: params.id,
    label: params.label,
    insertText: params.insertText,
    description: params.description,
    searchTerms: buildSearchTerms(params.label, params.aliases),
    depth: params.depth,
    sortIndex: params.sortIndex,
  };
}

function buildGenericRootEntry(
  definition: CanonicalSlashCommandDefinition,
  sortIndex: number,
): TuiSlashMenuEntry {
  const subcommands =
    definition.options?.filter(
      (option) => typeof option === 'object' && option?.kind === 'subcommand',
    ) ?? [];
  const stringOptions = definition.options?.filter(isStringOption) ?? [];
  return createMenuEntry({
    id: definition.name,
    label: `/${definition.name}`,
    insertText:
      subcommands.length > 0 || stringOptions.length > 0
        ? `/${definition.name} `
        : `/${definition.name}`,
    description: definition.description,
    aliases: TOP_LEVEL_ALIASES.get(definition.name),
    depth: 1,
    sortIndex,
  });
}

function buildGenericSubcommandEntry(
  commandName: string,
  subcommand: {
    name: string;
    description: string;
    options?: CanonicalSlashStringOptionDefinition[];
  },
  sortIndex: number,
): TuiSlashMenuEntry {
  const optionSuffix = formatOptionSuffix(subcommand.options);
  const label = optionSuffix
    ? `/${commandName} ${subcommand.name} ${optionSuffix}`
    : `/${commandName} ${subcommand.name}`;
  return createMenuEntry({
    id: `${commandName}.${subcommand.name}`,
    label,
    insertText: subcommand.options?.length
      ? `/${commandName} ${subcommand.name} `
      : `/${commandName} ${subcommand.name}`,
    description: subcommand.description,
    aliases: CHILD_ENTRY_ALIASES.get(`${commandName}.${subcommand.name}`),
    depth: 2,
    sortIndex,
  });
}

function subsequenceScore(query: string, target: string): number | null {
  if (!query) return 0;
  if (!target) return null;

  let queryIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (let i = 0; i < target.length && queryIndex < query.length; i += 1) {
    if (target[i] !== query[queryIndex]) continue;
    if (firstMatch < 0) firstMatch = i;
    lastMatch = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length || firstMatch < 0 || lastMatch < 0) {
    return null;
  }

  const span = lastMatch - firstMatch + 1;
  const gaps = span - query.length;
  return (
    SCORE_WEIGHTS.subsequenceBase -
    gaps * SCORE_WEIGHTS.subsequenceGapPenalty -
    firstMatch * SCORE_WEIGHTS.subsequenceStartPenalty
  );
}

function scoreSearchTerm(query: string, searchTerm: string): number | null {
  if (!query) return 0;

  const normalizedQuery = normalizeSearchText(query);
  const normalizedSearchTerm = normalizeSearchText(searchTerm);
  if (!normalizedQuery || !normalizedSearchTerm) return null;

  if (normalizedSearchTerm === normalizedQuery) {
    return (
      SCORE_WEIGHTS.exactNormalizedBase -
      normalizedSearchTerm.length * SCORE_WEIGHTS.exactLengthPenalty
    );
  }
  if (normalizedSearchTerm.startsWith(normalizedQuery)) {
    return (
      SCORE_WEIGHTS.prefixNormalizedBase -
      (normalizedSearchTerm.length - normalizedQuery.length) *
        SCORE_WEIGHTS.prefixLengthPenalty
    );
  }

  const substringIndex = normalizedSearchTerm.indexOf(normalizedQuery);
  if (substringIndex >= 0) {
    return (
      SCORE_WEIGHTS.substringNormalizedBase -
      substringIndex * SCORE_WEIGHTS.substringIndexPenalty
    );
  }

  const compactQuery = compactSearchText(normalizedQuery);
  const compactSearchTerm = compactSearchText(normalizedSearchTerm);
  if (!compactQuery || !compactSearchTerm) return null;

  if (compactSearchTerm === compactQuery) {
    return (
      SCORE_WEIGHTS.exactCompactBase -
      compactSearchTerm.length * SCORE_WEIGHTS.exactLengthPenalty
    );
  }
  if (compactSearchTerm.startsWith(compactQuery)) {
    return (
      SCORE_WEIGHTS.prefixCompactBase -
      (compactSearchTerm.length - compactQuery.length) *
        SCORE_WEIGHTS.prefixLengthPenalty
    );
  }

  return subsequenceScore(compactQuery, compactSearchTerm);
}

export function buildTuiSlashMenuEntries(): TuiSlashMenuEntry[] {
  const definitions = buildCanonicalSlashCommandDefinitions([]);
  const entries: TuiSlashMenuEntry[] = [];
  let sortIndex = 0;

  for (const definition of definitions) {
    entries.push(buildGenericRootEntry(definition, sortIndex));
    sortIndex += 1;

    const subcommands =
      definition.options?.filter(
        (option): option is {
          kind: 'subcommand';
          name: string;
          description: string;
          options?: CanonicalSlashStringOptionDefinition[];
        } => typeof option === 'object' && option?.kind === 'subcommand',
      ) ?? [];

    for (const subcommand of subcommands) {
      entries.push(
        buildGenericSubcommandEntry(definition.name, subcommand, sortIndex),
      );
      sortIndex += 1;

      for (const manualEntry of MANUAL_CHILD_ENTRIES.get(
        `${definition.name}.${subcommand.name}`,
      ) || []) {
        entries.push(
          createMenuEntry({
            ...manualEntry,
            aliases: manualEntry.aliases,
            depth: manualEntry.depth ?? 3,
            sortIndex,
          }),
        );
        sortIndex += 1;
      }
    }

    for (const manualEntry of MANUAL_CHILD_ENTRIES.get(definition.name) || []) {
      entries.push(
        createMenuEntry({
          ...manualEntry,
          aliases: manualEntry.aliases,
          depth: manualEntry.depth ?? 2,
          sortIndex,
        }),
      );
      sortIndex += 1;
    }
  }

  for (const manualEntry of EXTRA_ROOT_ENTRIES) {
    entries.push(
      createMenuEntry({
        ...manualEntry,
        aliases: manualEntry.aliases,
        depth: manualEntry.depth ?? 1,
        sortIndex,
      }),
    );
    sortIndex += 1;
  }

  return entries;
}

export function rankTuiSlashMenuEntries(
  entries: TuiSlashMenuEntry[],
  query: string,
): TuiSlashMenuEntry[] {
  const trimmedQuery = query.trim();
  return entries
    .map((entry) => {
      const bestScore = entry.searchTerms.reduce<number | null>(
        (currentBest, searchTerm) => {
          const nextScore = scoreSearchTerm(trimmedQuery, searchTerm);
          if (nextScore == null) return currentBest;
          if (currentBest == null || nextScore > currentBest) return nextScore;
          return currentBest;
        },
        trimmedQuery
          ? null
          : SCORE_WEIGHTS.emptyQueryBase -
              entry.depth * SCORE_WEIGHTS.emptyQueryDepthPenalty,
      );

      if (bestScore == null) return null;
      return {
        entry,
        score:
          bestScore +
          Math.max(
            0,
            SCORE_WEIGHTS.depthBonusBase -
              entry.depth * SCORE_WEIGHTS.depthBonusPenalty,
          ),
      };
    })
    .filter((entry): entry is { entry: TuiSlashMenuEntry; score: number } =>
      Boolean(entry),
    )
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.entry.depth !== right.entry.depth) {
        return left.entry.depth - right.entry.depth;
      }
      return left.entry.sortIndex - right.entry.sortIndex;
    })
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.entry);
}

export function resolveTuiSlashMenuQuery(
  line: string,
  cursor: number,
): string | null {
  if (cursor !== line.length) return null;
  if (!line.startsWith('/')) return null;
  if (line.includes('\n')) return null;

  const raw = line.slice(1);
  if (!raw.trim()) return '';
  if (/["'`[{]/.test(raw)) return null;

  const tokenCount = raw.trim().split(/\s+/).length;
  if (tokenCount > 3) return null;
  return raw.trim();
}

function buildMenuState(
  entries: TuiSlashMenuEntry[],
  line: string,
  cursor: number,
): TuiSlashMenuState | null {
  const query = resolveTuiSlashMenuQuery(line, cursor);
  if (query == null) return null;
  return {
    query,
    entries: rankTuiSlashMenuEntries(entries, query),
  };
}

export class TuiSlashMenuController {
  private readonly rl: InternalReadline;
  private readonly palette: TuiSlashMenuPalette;
  private readonly output: NodeJS.WriteStream;
  private readonly shouldShow: () => boolean;
  private readonly resizeHandler: () => void;
  private readonly originalTtyWrite: InternalReadline['_ttyWrite'] | undefined;
  private entries: TuiSlashMenuEntry[];
  private selectedIndex = 0;
  private lastQuery = '';
  private lastRenderSignature = '';
  private renderedLineCount = 0;

  constructor(params: {
    rl: readline.Interface;
    entries: TuiSlashMenuEntry[];
    palette: TuiSlashMenuPalette;
    output?: NodeJS.WriteStream;
    shouldShow?: () => boolean;
  }) {
    this.rl = params.rl as InternalReadline;
    this.entries = params.entries;
    this.palette = params.palette;
    this.output = params.output || process.stdout;
    this.shouldShow = params.shouldShow || (() => true);
    this.originalTtyWrite = this.rl._ttyWrite?.bind(this.rl);
    this.resizeHandler = () => {
      this.lastRenderSignature = '';
      this.sync();
    };
  }

  install(): void {
    if (!this.output.isTTY || !this.originalTtyWrite) return;

    // This monkey-patch is intentionally limited to the TUI session. It relies
    // on the current Node.js 22 readline implementation calling `_ttyWrite`
    // for raw-mode keypress handling before prompt redraw.
    this.rl._ttyWrite = (chunk: string, key: readline.Key) => {
      if (this.handleKeypress(key)) {
        this.sync();
        return;
      }
      this.originalTtyWrite?.(chunk, key);
      this.sync();
    };

    this.output.on('resize', this.resizeHandler);
    this.rl.on('close', () => this.dispose());
  }

  dispose(): void {
    this.clear();
    if (this.rl._ttyWrite && this.originalTtyWrite) {
      this.rl._ttyWrite = this.originalTtyWrite;
    }
    this.output.off('resize', this.resizeHandler);
  }

  setEntries(entries: TuiSlashMenuEntry[]): void {
    this.entries = entries;
    this.lastRenderSignature = '';
    this.sync();
  }

  clear(): void {
    if (!this.output.isTTY) return;
    if (this.renderedLineCount > 0) {
      this.output.write('\x1b7');
      readline.cursorTo(this.output, 0);
      readline.moveCursor(this.output, 0, 1);
      readline.clearScreenDown(this.output);
      this.output.write('\x1b8');
    }
    this.renderedLineCount = 0;
    this.lastRenderSignature = '';
  }

  sync(): void {
    if (!this.output.isTTY || !this.shouldShow()) {
      this.lastQuery = '';
      this.selectedIndex = 0;
      this.clear();
      return;
    }

    const state = buildMenuState(this.entries, this.rl.line, this.rl.cursor);
    if (!state) {
      this.lastQuery = '';
      this.selectedIndex = 0;
      this.clear();
      return;
    }

    if (state.query !== this.lastQuery) {
      this.selectedIndex = 0;
      this.lastQuery = state.query;
    }

    if (state.entries.length > 0) {
      this.selectedIndex = Math.max(
        0,
        Math.min(this.selectedIndex, state.entries.length - 1),
      );
    } else {
      this.selectedIndex = 0;
    }

    const lines = renderTuiSlashMenuLines({
      query: state.query,
      entries: state.entries,
      selectedIndex: this.selectedIndex,
      width: this.output.columns || 80,
      palette: this.palette,
    });

    const renderSignature = JSON.stringify({
      query: state.query,
      selectedIndex: this.selectedIndex,
      width: this.output.columns || 80,
      entryIds: state.entries.map((entry) => entry.id),
    });
    if (renderSignature === this.lastRenderSignature) return;

    this.clear();
    if (lines.length > 0) {
      this.output.write('\x1b7');
      readline.cursorTo(this.output, 0);
      this.output.write('\n');
      this.output.write(lines.join('\n'));
      this.output.write('\x1b8');
      this.renderedLineCount = lines.length;
    }
    this.lastRenderSignature = renderSignature;
  }

  private handleKeypress(key: readline.Key): boolean {
    if (!this.shouldShow()) return false;

    const state = buildMenuState(this.entries, this.rl.line, this.rl.cursor);
    if (!state) return false;

    if (key.name === 'escape') {
      this.lastQuery = '';
      this.selectedIndex = 0;
      this.clear();
      return true;
    }

    if (
      key.name === 'down' ||
      (key.ctrl === true && key.name === 'n')
    ) {
      if (state.entries.length === 0) return true;
      this.selectedIndex = (this.selectedIndex + 1) % state.entries.length;
      return true;
    }

    if (
      key.name === 'up' ||
      (key.ctrl === true && key.name === 'p') ||
      (key.name === 'tab' && key.shift === true)
    ) {
      if (state.entries.length === 0) return true;
      this.selectedIndex =
        (this.selectedIndex - 1 + state.entries.length) % state.entries.length;
      return true;
    }

    if (key.name !== 'right' && key.name !== 'tab') return false;
    if (state.entries.length === 0) return true;

    const selectedEntry = state.entries[this.selectedIndex];
    if (!selectedEntry) return true;

    // Mutating `line`/`cursor` keeps readline history and prompt state intact,
    // but it is also part of the same Node.js-internal contract documented
    // above.
    this.rl.line = selectedEntry.insertText;
    this.rl.cursor = selectedEntry.insertText.length;
    this.rl._refreshLine?.();
    return true;
  }
}
