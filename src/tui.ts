/**
 * HybridClaw TUI — thin client for the gateway API.
 * Usage: npm run tui
 */
import readline from 'node:readline';
import {
  APPROVE_COMMAND_USAGE,
  type ApprovalScopeMode,
} from './approval-commands.js';
import { TUI_CAPABILITIES } from './channels/channel.js';
import { registerChannel } from './channels/channel-registry.js';
import { buildLocalSessionSlashHelpEntries } from './command-registry.js';
import {
  APP_VERSION,
  GATEWAY_BASE_URL,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_MODEL,
} from './config/config.js';
import { createApprovalPresentation } from './gateway/approval-presentation.js';
import { extractGatewayChatApprovalEvent } from './gateway/chat-approval.js';
import {
  fetchGatewayAdminSkills,
  type GatewayChatApprovalEvent,
  type GatewayChatResult,
  type GatewayCommandResult,
  type GatewayMediaItem,
  type GatewayPluginCommandSummary,
  type GatewayProactiveMessage,
  gatewayChat,
  gatewayChatStream,
  gatewayCommand,
  gatewayHistory,
  gatewayPullProactive,
  gatewayStatus,
  gatewayUploadMedia,
  renderGatewayCommand,
  saveGatewayAdminSkillEnabled,
} from './gateway/gateway-client.js';
import {
  DEFAULT_SESSION_SHOW_MODE,
  isSessionShowMode,
  normalizeSessionShowMode,
  sessionShowModeShowsActivity,
  sessionShowModeShowsThinking,
  sessionShowModeShowsTools,
} from './gateway/show-mode.js';
import { logger } from './logger.js';
import { summarizeMediaFilenames } from './media/media-summary.js';
import {
  normalizeModelCandidates,
  parseModelInfoSummaryFromText,
  parseModelNamesFromListText,
  sortSelectableModelEntries,
} from './model-selection.js';
import {
  formatHybridAIModelForCatalog,
  formatModelCountSuffix,
  formatModelForDisplay,
  normalizeHybridAIModelForRuntime,
} from './providers/model-names.js';
import {
  formatTuiApprovalSummary,
  isTuiApprovalRestatement,
  parseTuiApprovalPrompt,
  type TuiApprovalDetails,
} from './tui-approval.js';
import {
  buildTuiApprovalSelectionOptions,
  promptTuiApprovalSelection,
} from './tui-approval-prompt.js';
import type { TuiStartupBannerSkillCategory } from './tui-banner.js';
import { renderTuiStartupBanner } from './tui-banner.js';
import {
  isProbablyWsl,
  loadTuiClipboardUploadCandidates,
} from './tui-clipboard.js';
import { formatTuiExitWarning, TuiExitController } from './tui-exit.js';
import { fetchTuiRemoteExitSummary } from './tui-exit-summary.js';
import {
  DEFAULT_TUI_FULLAUTO_STATE,
  deriveTuiFullAutoState,
  formatTuiFullAutoPromptLabel,
  parseFullAutoStatusText,
  shouldRouteTuiInputToFullAuto,
  type TuiFullAutoState,
} from './tui-fullauto.js';
import {
  buildTuiReadlineHistory,
  resolveTuiHistoryFetchLimit,
} from './tui-history.js';
import { TuiMultilineInputController } from './tui-input.js';
import { proactiveBadgeLabel, proactiveSourceSuffix } from './tui-proactive.js';
import {
  buildTuiExitSummaryLines,
  buildTuiUnavailableExitSummaryLines,
  generateTuiSessionId,
  type TuiRunOptions,
} from './tui-session.js';
import { promptTuiSkillConfig } from './tui-skill-config.js';
import {
  mapTuiApproveSlashToMessage,
  mapTuiSlashCommandToGatewayArgs,
  parseTuiSlashCommand,
} from './tui-slash-command.js';
import {
  buildTuiSlashMenuEntries,
  TuiSlashMenuController,
  type TuiSlashMenuPalette,
} from './tui-slash-menu.js';
import { stopTuiRun } from './tui-stop.js';
import {
  appendTerminalRowCount,
  countTerminalRows,
  createTuiStreamFormatState,
  createTuiThinkingStreamState,
  flushTuiStreamDelta,
  formatTuiStreamDelta,
  getTuiStreamTrailingNewlines,
  wrapTuiBlock,
} from './tui-thinking.js';
import type { SessionShowMode } from './types/session.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const JELLYFISH = '🪼';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const TUI_EXIT_CONFIRM_WINDOW_MS = 5000;

type TuiTheme = 'dark' | 'light';
type TuiReadlineInterface = readline.Interface & {
  history: string[];
  _refreshLine?: () => void;
  prevRows?: number;
};

interface TuiPalette {
  muted: string;
  teal: string;
  gold: string;
  green: string;
  lightGreen: string;
  red: string;
  activeSkill: string;
  inactiveSkill: string;
}

const DARK_PALETTE: TuiPalette = {
  muted: '\x1b[38;2;170;184;204m',
  teal: '\x1b[38;2;92;224;216m',
  gold: '\x1b[38;2;255;215;0m',
  green: '\x1b[38;2;16;185;129m',
  lightGreen: '\x1b[1;92m',
  red: '\x1b[38;2;239;68;68m',
  activeSkill: '\x1b[38;2;236;239;244m',
  inactiveSkill: '\x1b[38;2;170;184;204m',
};

const LIGHT_PALETTE: TuiPalette = {
  muted: '\x1b[38;2;88;99;116m',
  teal: '\x1b[38;2;0;122;128m',
  gold: '\x1b[38;2;138;97;0m',
  green: '\x1b[38;2;0;130;92m',
  lightGreen: '\x1b[1;92m',
  red: '\x1b[38;2;185;28;28m',
  activeSkill: '\x1b[38;2;16;24;40m',
  inactiveSkill: '\x1b[38;2;120;128;140m',
};

function inferThemeFromColorFgBg(): TuiTheme | null {
  const raw = process.env.COLORFGBG;
  if (!raw) return null;

  const parts = raw
    .split(/[;:]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const bg = Number.parseInt(parts[parts.length - 1], 10);
  if (Number.isNaN(bg)) return null;

  if (bg === 7 || bg === 11 || bg === 14 || bg === 15) return 'light';
  return 'dark';
}

function resolveTuiTheme(): TuiTheme {
  const override = (
    process.env.HYBRIDCLAW_THEME ||
    process.env.HYBRIDCLAW_TUI_THEME ||
    process.env.TUI_THEME ||
    ''
  )
    .trim()
    .toLowerCase();
  if (override === 'light' || override === 'dark') return override;
  return inferThemeFromColorFgBg() || 'dark';
}

const THEME = resolveTuiTheme();
const PALETTE = THEME === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
const MUTED = PALETTE.muted;
const TEAL = PALETTE.teal;
const GOLD = PALETTE.gold;
const GREEN = PALETTE.green;
const LIGHT_GREEN = '\x1b[1;92m';
const RED = PALETTE.red;
const WORDMARK_RAMP =
  THEME === 'light'
    ? ([
        '\x1b[38;2;24;86;156m',
        '\x1b[38;2;31;108;186m',
        '\x1b[38;2;38;130;214m',
        '\x1b[38;2;52;152;239m',
        '\x1b[38;2;38;130;214m',
        '\x1b[38;2;31;108;186m',
        '\x1b[38;2;24;86;156m',
      ] as const)
    : ([
        '\x1b[38;2;36;95;168m',
        '\x1b[38;2;46;122;202m',
        '\x1b[38;2;66;145;226m',
        '\x1b[38;2;78;176;245m',
        '\x1b[38;2;66;145;226m',
        '\x1b[38;2;46;122;202m',
        '\x1b[38;2;36;95;168m',
      ] as const);
const THINKING_PREVIEW_COLOR =
  THEME === 'light' ? '\x1b[38;2;145;154;170m' : '\x1b[38;2;116;129;148m';
const JELLYFISH_PULSE_FRAMES =
  THEME === 'light'
    ? ([
        {
          emojiColor: '\x1b[38;2;108;117;132m',
          verbColor: '\x1b[38;2;124;133;148m',
        },
        {
          emojiColor: '\x1b[38;2;124;133;148m',
          verbColor: '\x1b[38;2;140;149;164m',
        },
        {
          emojiColor: '\x1b[38;2;140;149;164m',
          verbColor: '\x1b[38;2;156;165;180m',
        },
        {
          emojiColor: '\x1b[38;2;124;133;148m',
          verbColor: '\x1b[38;2;140;149;164m',
        },
      ] as const)
    : ([
        {
          emojiColor: '\x1b[38;2;82;95;112m',
          verbColor: '\x1b[38;2;96;109;126m',
        },
        {
          emojiColor: '\x1b[38;2;102;115;132m',
          verbColor: '\x1b[38;2;116;129;146m',
        },
        {
          emojiColor: '\x1b[38;2;124;137;154m',
          verbColor: '\x1b[38;2;138;151;168m',
        },
        {
          emojiColor: '\x1b[38;2;102;115;132m',
          verbColor: '\x1b[38;2;116;129;146m',
        },
      ] as const);
const OCEAN_ACTIVITY_VERBS = [
  'swimming',
  'floating',
  'drifting',
  'gliding',
  'bobbing',
  'splashing',
  'sloshing',
  'surfing',
  'diving',
  'snorkeling',
  'snapping',
  'shoaling',
  'spouting',
  'whaling',
  'krilling',
  'squidging',
  'eel-ing',
  'coraling',
  'reefing',
  'kelping',
  'tidalizing',
  'currenting',
  'undertowing',
  'moonjell-ing',
  'anemone-ing',
  'barnacling',
  'seahorsing',
  'starfishing',
  'clamming',
  'musseling',
  'oystering',
  'crabbing',
  'lobstering',
  'shrimping',
  'dolphining',
  'dolphinking',
  'ottering',
  'orca-ing',
  'narwhaling',
  'submarinating',
  'planktoning',
  'bubbling',
  'foaming',
  'rippling',
  'sloshsurfing',
  'submarining',
  'treasurediving',
  'spongebobbing',
  'seashelling',
  'wavehopping',
  'depthcharging',
  'seaflooring',
] as const;

const CHANNEL_ID = 'tui';
const TUI_USER_ID = 'tui-user';
const TUI_USERNAME = 'user';
const TUI_MULTILINE_PASTE_DEBOUNCE_MS = Math.max(
  20,
  parseInt(process.env.TUI_MULTILINE_PASTE_DEBOUNCE_MS || '90', 10) || 90,
);
const TUI_ESCAPE_CODE_TIMEOUT_MS = 10;
const TUI_PROACTIVE_POLL_INTERVAL_MS = Math.max(
  500,
  parseInt(process.env.TUI_PROACTIVE_POLL_INTERVAL_MS || '10000', 10) || 10000,
);
const TUI_PROACTIVE_PULL_LIMIT = 100;
const TUI_HISTORY_SIZE = 100;
const TOOL_PREVIEW_MAX_CHARS = 140;
const TUI_APPROVAL_PRESENTATION = createApprovalPresentation('text');

function formatToolPreview(preview: string | undefined): string {
  const normalized = (preview || '').replace(/\s+/g, ' ').trim();
  return normalized.length > TOOL_PREVIEW_MAX_CHARS
    ? `${normalized.slice(0, TOOL_PREVIEW_MAX_CHARS - 1)}…`
    : normalized;
}

let activeRunAbortController: AbortController | null = null;
let activeRunStopInFlight: Promise<GatewayCommandResult> | null = null;
let proactivePollInFlight = false;
let delegateStatusRows = 0;
let delegateStreamActive = false;
let delegateStreamFormatState = createTuiStreamFormatState();
let tuiFullAutoState: TuiFullAutoState = DEFAULT_TUI_FULLAUTO_STATE;
let fullAutoSteeringInFlight = false;
type TuiCachedApproval = {
  requestId: string;
  summary: string;
  intent: string;
  reason: string;
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
};

let tuiPendingApproval: TuiCachedApproval | null = null;
let tuiShowMode: SessionShowMode = DEFAULT_SESSION_SHOW_MODE;
let tuiSlashMenu: TuiSlashMenuController | null = null;
let tuiSessionId = generateTuiSessionId();
let tuiPendingMedia: GatewayMediaItem[] = [];
let tuiPendingMediaUploads = 0;
let tuiClipboardPasteInFlight = false;
let tuiSessionMode: 'new' | 'resume' = 'new';
let tuiSessionStartedAtMs = Date.now();
let tuiResumeCommand = 'hybridclaw tui --resume';
let tuiExitInProgress = false;
let tuiLoadedPluginCommandNames = new Set<string>();

function mapApprovalSelectionToCommand(
  selection: string,
  requestId: string,
  options: Array<ApprovalScopeMode | 'skip'>,
): string | null {
  const normalized = selection.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return null;

  const indexedMatch = normalized.match(/^\d+$/);
  if (indexedMatch) {
    const index = Number.parseInt(normalized, 10) - 1;
    const selected = options[index];
    if (!selected) return null;
    if (selected === 'once') return `yes ${requestId}`;
    if (selected === 'session') return `yes ${requestId} for session`;
    if (selected === 'agent') return `yes ${requestId} for agent`;
    if (selected === 'all') return `yes ${requestId} for all`;
    return `skip ${requestId}`;
  }

  if (normalized === 'yes' || normalized === 'y' || normalized === 'once') {
    return `yes ${requestId}`;
  }
  if (
    options.includes('session') &&
    (normalized === 'session' ||
      normalized === 'yes for session' ||
      normalized === 'for session')
  ) {
    return `yes ${requestId} for session`;
  }
  if (
    options.includes('agent') &&
    (normalized === 'agent' ||
      normalized === 'yes for agent' ||
      normalized === 'for agent')
  ) {
    return `yes ${requestId} for agent`;
  }
  if (
    options.includes('all') &&
    (normalized === 'all' ||
      normalized === 'yes for all' ||
      normalized === 'for all')
  ) {
    return `yes ${requestId} for all`;
  }
  if (normalized === 'no' || normalized === 'n' || normalized === 'skip') {
    return `skip ${requestId}`;
  }
  return null;
}

function isApprovalResponseContent(content: string): boolean {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  return (
    /^(yes|skip)\s+\S+(?:\s+for\s+(session|all|agent))?$/.test(normalized) ||
    /^\/approve\s+(yes|once|session|agent|all|no|deny|skip|[1-5])(?:\s+\S+)?$/u.test(
      normalized,
    )
  );
}

function normalizeApprovalReplayForGateway(content: string): string {
  const normalized = content.trim();
  if (normalized.startsWith('/approve')) {
    return normalized;
  }
  const allowMatch = /^yes\s+(\S+)(?:\s+for\s+(session|agent|all))?$/iu.exec(
    normalized,
  );
  if (allowMatch) {
    const approvalId = allowMatch[1];
    const mode = (allowMatch[2] || '').toLowerCase();
    if (mode === 'session') {
      return `/approve session ${approvalId}`;
    }
    if (mode === 'agent') {
      return `/approve agent ${approvalId}`;
    }
    if (mode === 'all') {
      return `/approve all ${approvalId}`;
    }
    return `/approve yes ${approvalId}`;
  }
  const denyMatch = /^(?:skip|no)\s+(\S+)$/iu.exec(normalized);
  if (denyMatch?.[1]) {
    return `/approve no ${denyMatch[1]}`;
  }
  return normalized;
}

async function submitApprovalReplay(
  content: string,
  rl: readline.Interface,
): Promise<void> {
  await processMessage(normalizeApprovalReplayForGateway(content), rl);
}

function resolvePendingApproval(
  result: GatewayChatResult,
  streamedApproval: GatewayChatApprovalEvent | null,
  cachedApproval?: TuiApprovalDetails | null,
): TuiApprovalDetails | null {
  if (streamedApproval) {
    return {
      approvalId: streamedApproval.approvalId,
      intent: streamedApproval.intent,
      reason: streamedApproval.reason,
      allowSession: streamedApproval.allowSession,
      allowAgent: streamedApproval.allowAgent,
      allowAll: streamedApproval.allowAll,
    };
  }

  const pendingApproval = extractGatewayChatApprovalEvent(result);
  if (pendingApproval) {
    return {
      approvalId: pendingApproval.approvalId,
      intent: pendingApproval.intent,
      reason: pendingApproval.reason,
      allowSession: pendingApproval.allowSession,
      allowAgent: pendingApproval.allowAgent,
      allowAll: pendingApproval.allowAll,
    };
  }

  const prompt = String(result.result || '').trim();
  if (!prompt) return null;
  const parsedPrompt = parseTuiApprovalPrompt(prompt);
  if (parsedPrompt) return parsedPrompt;
  return cachedApproval && isTuiApprovalRestatement(prompt)
    ? cachedApproval
    : null;
}

function resolveCachedApprovalDetails(
  pendingApproval: TuiCachedApproval | null,
): TuiApprovalDetails | null {
  if (!pendingApproval) return null;
  return {
    approvalId: pendingApproval.requestId,
    intent: pendingApproval.intent,
    reason: pendingApproval.reason,
    allowSession: pendingApproval.allowSession,
    allowAgent: pendingApproval.allowAgent,
    allowAll: pendingApproval.allowAll,
  };
}

async function promptApprovalSelection(
  rl: readline.Interface,
  pendingApproval: TuiApprovalDetails,
): Promise<string | null> {
  const options = buildTuiApprovalSelectionOptions({
    allowSession: pendingApproval.allowSession,
    allowAgent: pendingApproval.allowAgent,
    allowAll: pendingApproval.allowAll,
  });
  clearTuiSlashMenu();
  const result = await promptTuiApprovalSelection({
    rl,
    approval: pendingApproval,
    options,
    restorePrompt: false,
  });
  if (result !== undefined) {
    return mapApprovalSelectionToCommand(
      result,
      pendingApproval.approvalId,
      options,
    );
  }

  const summary = formatTuiApprovalSummary(pendingApproval);
  if (TUI_APPROVAL_PRESENTATION.showText) {
    printResponse(summary);
  }
  console.log(
    `  ${BOLD}${GOLD}Approval options${RESET} ${MUTED}(request ${pendingApproval.approvalId})${RESET}`,
  );
  options.forEach((option, index) => {
    const label =
      option === 'once'
        ? 'yes (once)'
        : option === 'session'
          ? 'yes for session'
          : option === 'agent'
            ? 'yes for agent'
            : option === 'all'
              ? 'yes for all'
              : 'no / skip';
    console.log(`  ${TEAL}${index + 1}${RESET} ${label}`);
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `  ${MUTED}Select 1-${options.length} (Enter to skip):${RESET} `,
      resolve,
    );
  });
  const command = mapApprovalSelectionToCommand(
    answer,
    pendingApproval.approvalId,
    options,
  );
  if (answer.trim() && !command) {
    printInfo(
      `Unrecognized selection "${answer.trim()}". You can reply manually with yes/skip and the request id.`,
    );
  }
  return command;
}

async function handleTuiPendingApproval(
  pendingApproval: TuiApprovalDetails,
  rl: readline.Interface,
): Promise<void> {
  const summary = formatTuiApprovalSummary(pendingApproval);
  tuiPendingApproval = {
    requestId: pendingApproval.approvalId,
    summary,
    intent: pendingApproval.intent,
    reason: pendingApproval.reason,
    allowSession: pendingApproval.allowSession,
    allowAgent: pendingApproval.allowAgent,
    allowAll: pendingApproval.allowAll,
  };
  const approvalCommand = await promptApprovalSelection(rl, pendingApproval);
  if (approvalCommand) {
    await submitApprovalReplay(approvalCommand, rl);
  }
}

function printBanner(
  modelInfo: {
    current: string;
    defaultModel: string;
  },
  sandboxMode: 'container' | 'host',
  skillCategories: TuiStartupBannerSkillCategory[],
): void {
  clearTuiSlashMenu();
  console.log();
  for (const line of renderTuiStartupBanner({
    columns: terminalColumns(),
    info: {
      currentModel: modelInfo.current,
      defaultModel: modelInfo.defaultModel,
      sandboxMode,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      hybridAIBaseUrl: HYBRIDAI_BASE_URL,
      chatbotId: HYBRIDAI_CHATBOT_ID || 'unset',
      version: APP_VERSION,
      skillCategories,
    },
    palette: {
      reset: RESET,
      bold: BOLD,
      muted: MUTED,
      teal: TEAL,
      gold: GOLD,
      green: GREEN,
      activeSkill: PALETTE.activeSkill,
      inactiveSkill: PALETTE.inactiveSkill,
      wordmarkRamp: WORDMARK_RAMP,
    },
  })) {
    console.log(line);
  }
  console.log();
}

function formatSkillCategoryLabel(category: string): string {
  const parts = String(category || '')
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean);
  if (parts.length === 0) return 'Uncategorized';
  return parts.map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

function buildStartupSkillCategories(
  skills: Array<{
    name: string;
    category: string;
    available: boolean;
    enabled: boolean;
  }>,
): TuiStartupBannerSkillCategory[] {
  const grouped = new Map<string, TuiStartupBannerSkillCategory['skills']>();

  for (const skill of skills) {
    const category = formatSkillCategoryLabel(skill.category);
    const entry = {
      name: skill.name,
      active: skill.enabled && skill.available,
    };
    const existing = grouped.get(category);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(category, [entry]);
    }
  }

  return Array.from(grouped.entries()).map(([category, groupedSkills]) => ({
    category,
    skills: groupedSkills,
  }));
}

async function fetchStartupSkillCategories(): Promise<
  TuiStartupBannerSkillCategory[]
> {
  try {
    const response = await fetchGatewayAdminSkills();
    return buildStartupSkillCategories(response.skills);
  } catch (error) {
    logger.debug(
      { error },
      'Failed to load active skills for TUI startup banner',
    );
    return [];
  }
}

function printHelp(): void {
  clearTuiSlashMenu();
  const pasteShortcutLabel =
    process.platform === 'linux' && isProbablyWsl()
      ? 'Ctrl+V / Ctrl+Alt+V'
      : 'Ctrl+V';
  const helpEntries = buildLocalSessionSlashHelpEntries('tui');
  const shortCommandWidth = 18;
  console.log();
  console.log(`  ${BOLD}${GOLD}Commands${RESET}`);
  console.log(
    `  ${TEAL}TAB${RESET} accept suggestion ${MUTED}|${RESET} ${TEAL}Ctrl-N/Ctrl-P${RESET} navigate slash menu ${MUTED}|${RESET} ${TEAL}Shift+Return${RESET}/${TEAL}Ctrl-J${RESET} line break ${MUTED}|${RESET} ${TEAL}ESC${RESET} close menu`,
  );
  console.log(
    `  ${TEAL}${pasteShortcutLabel}${RESET} ${pasteShortcutLabel.length < 18 ? ' '.repeat(18 - pasteShortcutLabel.length) : ''}Queue a copied file or clipboard image`,
  );
  console.log(`  ${TEAL}ESC${RESET}               Interrupt current request`);
  console.log(
    `  ${TEAL}Context injection:${RESET} ${TEAL}@file${RESET} ${TEAL}@folder${RESET} ${TEAL}@diff${RESET} ${TEAL}@staged${RESET} ${TEAL}@git${RESET}`,
  );
  console.log();
  for (const { command, description } of helpEntries) {
    console.log(
      `  ${TEAL}${command.padEnd(shortCommandWidth)}${RESET} ${description}`,
    );
  }
  console.log();
}

function printResponse(
  text: string,
  options?: {
    leadingBlank?: boolean;
  },
): void {
  clearTuiSlashMenu();
  if (options?.leadingBlank !== false) {
    console.log();
  }
  console.log(formatTuiOutput(text));
  console.log();
}

function printError(
  text: string,
  options?: {
    leadingBlank?: boolean;
  },
): void {
  clearTuiSlashMenu();
  const prefix = options?.leadingBlank === false ? '' : '\n';
  const wrapped = formatTuiOutput(`Error: ${text}`);
  const colored = wrapped
    .split('\n')
    .map((line) => `${RED}${line}${RESET}`)
    .join('\n');
  console.log(`${prefix}${colored}\n`);
}

function printInfo(text: string): void {
  clearTuiSlashMenu();
  console.log();
  for (const line of formatTuiOutput(text).split('\n')) {
    console.log(`${GOLD}${line}${RESET}`);
  }
  console.log();
}

async function handleTuiClipboardPaste(rl: readline.Interface): Promise<void> {
  if (tuiClipboardPasteInFlight) {
    printInfo('Attachment upload is already in progress.');
    refreshPrompt(rl);
    return;
  }
  if (activeRunAbortController && !activeRunAbortController.signal.aborted) {
    printInfo('Wait for the current reply to finish before attaching media.');
    refreshPrompt(rl);
    return;
  }

  tuiClipboardPasteInFlight = true;
  tuiPendingMediaUploads += 1;
  refreshPrompt(rl);

  try {
    const candidates = await loadTuiClipboardUploadCandidates();
    if (candidates.length === 0) {
      printInfo(
        'Clipboard does not contain a readable local file or image, or the local clipboard backend is unavailable.',
      );
      return;
    }

    const uploaded: GatewayMediaItem[] = [];
    for (const candidate of candidates) {
      const result = await gatewayUploadMedia({
        filename: candidate.filename,
        body: candidate.body,
        mimeType: candidate.mimeType,
      });
      uploaded.push(result.media);
    }
    if (uploaded.length === 0) {
      printInfo('Clipboard did not contain any readable files.');
      return;
    }

    tuiPendingMedia = [...tuiPendingMedia, ...uploaded];
    printInfo(`Queued ${summarizeGatewayMediaItems(uploaded)}.`);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err), {
      leadingBlank: false,
    });
  } finally {
    tuiPendingMediaUploads = Math.max(0, tuiPendingMediaUploads - 1);
    tuiClipboardPasteInFlight = false;
    refreshPrompt(rl);
  }
}

function isModelCatalogCommandResult(result: GatewayCommandResult): boolean {
  const title = String(result.title || '').trim();
  return title.startsWith('Available Models') || title === 'Default Model';
}

function isEvalResultsCommandResult(result: GatewayCommandResult): boolean {
  const title = String(result.title || '').trim();
  return (
    title === 'Terminal-Bench 2.0 Results' ||
    title === 'tau2 Results' ||
    title === 'LOCOMO Results'
  );
}

interface TuiSectionCard {
  title: string;
  rows: string[];
}

function stripAnsiTui(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; ) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === '[') {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        index += 1;
        if (code >= 64 && code <= 126) break;
      }
      continue;
    }
    output += value[index] || '';
    index += 1;
  }
  return output;
}

function tuiCharacterWidth(symbol: string): number {
  const code = symbol.codePointAt(0);
  if (code == null) return 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x200d ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function nextTuiSymbol(
  source: string,
  index: number,
): { symbol: string; nextIndex: number } {
  const code = source.codePointAt(index);
  const symbol =
    code == null ? source[index] || '' : String.fromCodePoint(code);
  return {
    symbol,
    nextIndex: index + (symbol.length || 1),
  };
}

export function visibleTuiLength(value: string): number {
  const source = String(value || '');
  let width = 0;
  for (let index = 0; index < source.length; ) {
    if (source.charCodeAt(index) === 27 && source[index + 1] === '[') {
      index += 2;
      while (index < source.length) {
        const code = source.charCodeAt(index);
        index += 1;
        if (code >= 64 && code <= 126) break;
      }
      continue;
    }

    const next = nextTuiSymbol(source, index);
    width += tuiCharacterWidth(next.symbol);
    index = next.nextIndex;
  }
  return width;
}

function padAnsiTuiEnd(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - visibleTuiLength(value)))}`;
}

type TuiAnsiToken =
  | { kind: 'ansi'; value: string }
  | { kind: 'char'; value: string };

function tokenizeAnsiTui(value: string): TuiAnsiToken[] {
  const source = String(value || '');
  const tokens: TuiAnsiToken[] = [];
  for (let index = 0; index < source.length; ) {
    if (source.charCodeAt(index) === 27 && source[index + 1] === '[') {
      const start = index;
      index += 2;
      while (index < source.length) {
        const code = source.charCodeAt(index);
        index += 1;
        if (code >= 64 && code <= 126) break;
      }
      tokens.push({ kind: 'ansi', value: source.slice(start, index) });
      continue;
    }
    const next = nextTuiSymbol(source, index);
    tokens.push({ kind: 'char', value: next.symbol });
    index = next.nextIndex;
  }
  return tokens;
}

function trimAnsiTuiCell(value: string): string {
  const tokens = tokenizeAnsiTui(value);
  const trimmedLeading: TuiAnsiToken[] = [];
  const pendingAnsi: TuiAnsiToken[] = [];
  let started = false;

  for (const token of tokens) {
    if (token.kind === 'ansi') {
      if (started) {
        trimmedLeading.push(token);
      } else {
        pendingAnsi.push(token);
      }
      continue;
    }
    if (!started && token.value === ' ') {
      continue;
    }
    if (!started) {
      trimmedLeading.push(...pendingAnsi);
      started = true;
    }
    trimmedLeading.push(token);
  }

  const trailingAnsi: TuiAnsiToken[] = [];
  while (
    trimmedLeading.length > 0 &&
    trimmedLeading[trimmedLeading.length - 1]?.kind === 'ansi'
  ) {
    trailingAnsi.unshift(trimmedLeading.pop() as TuiAnsiToken);
  }
  while (
    trimmedLeading.length > 0 &&
    trimmedLeading[trimmedLeading.length - 1]?.kind === 'char' &&
    trimmedLeading[trimmedLeading.length - 1]?.value === ' '
  ) {
    trimmedLeading.pop();
  }
  if (trimmedLeading.length === 0) return '';
  return [...trimmedLeading, ...trailingAnsi]
    .map((token) => token.value)
    .join('');
}

function sliceAnsiTuiVisible(
  value: string,
  start: number,
  width: number,
): string {
  if (width <= 0) return '';
  const end = start + width;
  const tokens = tokenizeAnsiTui(value);
  const output: TuiAnsiToken[] = [];
  const pendingAnsi: TuiAnsiToken[] = [];
  let visibleIndex = 0;
  let started = false;
  let finished = false;

  for (const token of tokens) {
    if (token.kind === 'ansi') {
      if (finished) {
        output.push(token);
        continue;
      }
      if (started || visibleIndex >= start) {
        pendingAnsi.push(token);
      }
      continue;
    }

    if (visibleIndex >= start && visibleIndex < end) {
      if (!started) {
        output.push(...pendingAnsi);
        pendingAnsi.length = 0;
        started = true;
      }
      output.push(token);
    } else if (started && visibleIndex >= end) {
      finished = true;
      break;
    }
    visibleIndex += 1;
    if (visibleIndex >= end && started) {
      finished = true;
    }
    if (!started) {
      pendingAnsi.length = 0;
    }
  }

  return output.map((token) => token.value).join('');
}

function truncateAnsiTuiEnd(value: string, width: number): string {
  if (width <= 0) return '';
  const source = String(value || '');
  if (visibleTuiLength(source) <= width) return source;
  if (width === 1) return '…';

  let output = '';
  let visibleCount = 0;
  for (let index = 0; index < source.length; ) {
    if (source.charCodeAt(index) === 27 && source[index + 1] === '[') {
      const start = index;
      index += 2;
      while (index < source.length) {
        const code = source.charCodeAt(index);
        index += 1;
        if (code >= 64 && code <= 126) break;
      }
      output += source.slice(start, index);
      continue;
    }
    const next = nextTuiSymbol(source, index);
    const symbolWidth = tuiCharacterWidth(next.symbol);
    if (symbolWidth > 0 && visibleCount + symbolWidth + 1 > width) {
      output += '…';
      return output.endsWith(RESET) ? output : `${output}${RESET}`;
    }
    output += next.symbol;
    visibleCount += symbolWidth;
    index = next.nextIndex;
  }
  return output;
}

function looksLikeTuiTableSection(rows: readonly string[]): boolean {
  if (rows.length < 2) return false;
  const headerCells = rows[0]?.split(/ {2,}/).filter(Boolean) || [];
  if (headerCells.length < 3) return false;
  return /^[- ]+$/u.test(stripAnsiTui(rows[1] || ''));
}

function reflowTuiTableSection(
  rows: readonly string[],
  innerWidth: number,
): string[] | null {
  if (!looksLikeTuiTableSection(rows)) return null;
  const separator = '  ';
  const sourceWidths = String(rows[1] || '')
    .split(/ {2,}/)
    .filter(Boolean)
    .map((entry) => entry.length);
  const columnCount = sourceWidths.length;
  if (columnCount < 3) return null;
  const parseRow = (row: string): string[] => {
    let offset = 0;
    return sourceWidths.map((width, index) => {
      const cell = trimAnsiTuiCell(sliceAnsiTuiVisible(row, offset, width));
      offset += width;
      if (index < sourceWidths.length - 1) {
        offset += separator.length;
      }
      return cell;
    });
  };
  const headerCells = parseRow(rows[0] || '');
  const bodyRows = rows.slice(2).map((row) => parseRow(row));
  if (bodyRows.some((row) => row.length !== columnCount)) {
    return null;
  }
  const tableRows = [headerCells, ...bodyRows];

  const metricWidths = Array.from(
    { length: columnCount - 1 },
    (_, metricIndex) =>
      Math.max(
        visibleTuiLength(tableRows[0]?.[metricIndex + 1] || ''),
        ...tableRows.map((row) => visibleTuiLength(row[metricIndex + 1] || '')),
      ),
  );
  const minVariantWidth = Math.max(
    7,
    visibleTuiLength(tableRows[0]?.[0] || ''),
  );
  const availableVariantWidth =
    innerWidth -
    metricWidths.reduce((total, width) => total + width, 0) -
    separator.length * (columnCount - 1);
  if (availableVariantWidth < minVariantWidth) {
    return null;
  }
  const variantWidth = Math.min(
    Math.max(
      minVariantWidth,
      ...tableRows.slice(1).map((row) => visibleTuiLength(row[0] || '')),
    ),
    availableVariantWidth,
  );

  return tableRows.flatMap((row, index) => {
    if (index === 1) {
      return [
        [variantWidth, ...metricWidths]
          .map((width) => '-'.repeat(width))
          .join(separator),
      ];
    }
    const cells = row.map((cell, cellIndex) => {
      const width =
        cellIndex === 0 ? variantWidth : metricWidths[cellIndex - 1];
      return padAnsiTuiEnd(truncateAnsiTuiEnd(cell, width), width);
    });
    return [cells.join(separator)];
  });
}

export function parseTuiSectionCards(text: string): TuiSectionCard[] {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const sections: TuiSectionCard[] = [];
  let currentTitle: string | null = null;
  let currentRows: string[] = [];

  const flush = () => {
    if (!currentTitle) return;
    sections.push({ title: currentTitle, rows: [...currentRows] });
    currentTitle = null;
    currentRows = [];
  };

  for (const line of lines) {
    const topMatch = line.match(/^┌─\s*(.*?)\s*─+┐$/u);
    if (topMatch) {
      flush();
      currentTitle = String(topMatch[1] || '').trim();
      currentRows = [];
      continue;
    }
    if (/^└[─]+┘$/u.test(line)) {
      flush();
      continue;
    }
    const rowMatch = line.match(/^│\s?(.*?)\s?│$/u);
    if (rowMatch && currentTitle) {
      currentRows.push(String(rowMatch[1] || '').trimEnd());
    }
  }

  flush();
  return sections;
}

export function renderTuiEvalResultsPanel(
  sections: readonly TuiSectionCard[],
  columns: number,
): string[] {
  const innerWidth = Math.max(16, Math.floor(columns || 80) - 7);
  const lines: string[] = [];
  const pushBorder = (
    left: '╭' | '├' | '╰',
    fill: string,
    right: '╮' | '┤' | '╯',
  ) => {
    lines.push(
      `  ${MUTED}${left}${fill.repeat(innerWidth + 2)}${right}${RESET}`,
    );
  };
  const pushRow = (text = '', color = '') => {
    const padded = padAnsiTuiEnd(text, innerWidth);
    const content = color ? `${color}${padded}${RESET}` : padded;
    lines.push(`  ${MUTED}│${RESET} ${content} ${MUTED}│${RESET}`);
  };

  sections.forEach((section, index) => {
    pushBorder(index === 0 ? '╭' : '├', '─', index === 0 ? '╮' : '┤');
    pushRow(section.title, `${BOLD}${GOLD}`);
    const tableRows = reflowTuiTableSection(section.rows, innerWidth);
    if (tableRows) {
      for (const row of tableRows) {
        pushRow(row);
      }
      return;
    }
    for (const row of section.rows) {
      for (const wrapped of wrapTuiBlock(row, innerWidth, '').split('\n')) {
        pushRow(wrapped);
      }
    }
  });
  pushBorder('╰', '─', '╯');
  return lines;
}

function printModelCatalogCommandResult(result: GatewayCommandResult): void {
  clearTuiSlashMenu();
  console.log();
  if (result.title) {
    console.log(`  ${GOLD}${result.title}${RESET}`);
  }
  if (Array.isArray(result.modelCatalog) && result.modelCatalog.length > 0) {
    for (const entry of result.modelCatalog) {
      const marker = entry.recommended ? `${LIGHT_GREEN}★ ${RESET}` : '';
      const color = entry.recommended
        ? LIGHT_GREEN
        : entry.isFree
          ? GREEN
          : GOLD;
      console.log(`  ${marker}${color}${entry.label}${RESET}`);
    }
    console.log();
    console.log(
      `  ${MUTED}${formatModelCountSuffix(result.modelCatalog.length)}${RESET}`,
    );
    console.log();
    return;
  }
  for (const line of result.text.split('\n')) {
    console.log(`  ${GOLD}${line}${RESET}`);
  }
  console.log();
}

function printUsageFooter(
  tools: string[],
  plugins: string[],
  skill: string | undefined,
): void {
  const parts: string[] = [];
  if (tools.length > 0) {
    parts.push(`🔧 ${GREEN}${tools.join(', ')}${RESET}`);
  }
  if (plugins.length > 0) {
    parts.push(`🔌 ${GREEN}${plugins.join(', ')}${RESET}`);
  }
  if (skill) {
    parts.push(`⚡ ${GREEN}${skill}${RESET}`);
  }
  if (parts.length === 0) return;
  clearTuiSlashMenu();
  console.log(`  ${MUTED}${JELLYFISH}${RESET} ${parts.join(`  `)}`);
}

function terminalColumns(): number {
  return Math.max(24, process.stdout.columns || 120);
}

function formatTuiOutput(text: string): string {
  return wrapTuiBlock(text, terminalColumns(), '  ');
}

export function formatTuiTitledCommandBlock(
  title: string,
  text: string,
  width: number,
): string[] {
  const lines = wrapTuiBlock(title, width, '  ').split('\n');
  if (!text.trim()) return lines;
  return [...lines, '', ...wrapTuiBlock(text, width, '  ').split('\n')];
}

function isInactiveSkillListLine(line: string): boolean {
  return /\[disabled\]/i.test(line);
}

function printGatewayCommandResult(result: GatewayCommandResult): void {
  if (result.kind === 'error') {
    const prefix = result.title ? `${result.title}: ` : '';
    printError(`${prefix}${result.text}`);
    return;
  }
  if (isModelCatalogCommandResult(result)) {
    printModelCatalogCommandResult(result);
    return;
  }
  const rendered = renderGatewayCommand(result);
  if (result.title === 'Skills') {
    clearTuiSlashMenu();
    console.log();
    for (const line of formatTuiOutput(rendered).split('\n')) {
      const color = isInactiveSkillListLine(line) ? MUTED : GOLD;
      console.log(`${color}${line}${RESET}`);
    }
    console.log();
    return;
  }
  if (isEvalResultsCommandResult(result)) {
    clearTuiSlashMenu();
    console.log();
    console.log(`${GOLD}${result.title || ''}${RESET}`);
    console.log();
    const sections = parseTuiSectionCards(result.text);
    if (sections.length > 0) {
      for (const line of renderTuiEvalResultsPanel(
        sections,
        terminalColumns(),
      )) {
        console.log(line);
      }
    } else {
      for (const line of formatTuiOutput(result.text).split('\n')) {
        console.log(`${GOLD}${line}${RESET}`);
      }
    }
    console.log();
    return;
  }
  if (result.title) {
    clearTuiSlashMenu();
    console.log();
    for (const line of formatTuiTitledCommandBlock(
      result.title,
      result.text,
      terminalColumns(),
    )) {
      if (!line) {
        console.log();
        continue;
      }
      console.log(`${GOLD}${line}${RESET}`);
    }
    console.log();
    return;
  }
  printInfo(rendered);
}

function pickOceanActivityVerb(): string {
  const index = Math.floor(Math.random() * OCEAN_ACTIVITY_VERBS.length);
  return OCEAN_ACTIVITY_VERBS[index] || 'floating';
}

export interface SpinnerToolEntry {
  name: string;
  preview: string;
  count: number;
}

export function formatTuiToolActivityLine(params: {
  toolName: string;
  preview?: string;
  columns: number;
  frameIndex?: number;
  count?: number;
}): string {
  const frameIndex = Math.max(0, params.frameIndex || 0);
  const frame =
    JELLYFISH_PULSE_FRAMES[frameIndex % JELLYFISH_PULSE_FRAMES.length];
  const previewText = params.preview
    ? ` ${MUTED}${params.preview}${RESET}`
    : '';
  const count = Math.max(1, params.count || 1);
  const countText = count > 1 ? ` ${MUTED}x${count}${RESET}` : '';
  const body = `  ${frame.emojiColor}${JELLYFISH}${RESET} ${TEAL}${params.toolName}${RESET}${countText}${previewText}`;
  const safeColumns = Math.max(1, params.columns - 1);
  return truncateAnsiTuiEnd(body, safeColumns);
}

export function formatTuiToolActivityBlock(params: {
  entries: SpinnerToolEntry[];
  columns: number;
  frameIndex?: number;
}): string[] {
  return params.entries.map((entry) =>
    formatTuiToolActivityLine({
      toolName: entry.name,
      preview: entry.preview,
      columns: params.columns,
      frameIndex: params.frameIndex,
      count: entry.count,
    }),
  );
}

function spinner(): {
  stop: () => void;
  addTool: (toolName: string, preview?: string) => void;
  finishTool: (toolName: string, preview?: string) => void;
  addVisibleTextDelta: (delta: string) => void;
  flushVisibleText: () => void;
  clearVisibleText: () => void;
  trailingNewlinesAfterVisibleText: () => string;
  setThinkingPreview: (preview: string | null) => void;
  clearThinkingPreview: () => void;
  clearTools: () => void;
} {
  const showActivityPreview = sessionShowModeShowsActivity(tuiShowMode);
  const showThinkingPreview = sessionShowModeShowsThinking(tuiShowMode);
  const showTools = sessionShowModeShowsTools(tuiShowMode);
  const activityVerb = pickOceanActivityVerb();

  let i = 0;
  let stopped = false;
  let cursorHidden = false;
  const toolEntries: SpinnerToolEntry[] = [];
  let hasVisibleText = false;
  let visibleTextState = createTuiStreamFormatState();
  let visibleTextRows = 0;
  let thinkingPreviewRows = 0;
  let toolActivityRows = 0;
  const clearLine = () => process.stdout.write('\r\x1b[2K');
  const clearRows = (rows: number) => {
    const normalizedRows = Math.max(0, rows);
    if (normalizedRows <= 0) return;
    if (!process.stdout.isTTY) return;
    if (normalizedRows > 1) process.stdout.write(`\x1b[${normalizedRows - 1}A`);
    for (let row = 0; row < normalizedRows; row += 1) {
      clearLine();
      if (row < normalizedRows - 1) process.stdout.write('\n');
    }
    if (normalizedRows > 1) process.stdout.write(`\x1b[${normalizedRows - 1}A`);
  };
  const hideCursor = () => {
    if (cursorHidden || !process.stdout.isTTY) return;
    process.stdout.write(HIDE_CURSOR);
    cursorHidden = true;
  };
  const showCursor = () => {
    if (!cursorHidden || !process.stdout.isTTY) return;
    process.stdout.write(SHOW_CURSOR);
    cursorHidden = false;
  };
  const clearToolActivityBlock = () => {
    if (toolActivityRows > 0) {
      clearRows(toolActivityRows);
      toolActivityRows = 0;
      return;
    }
    clearLine();
  };
  const repaintToolBlock = (frameIdx: number) => {
    if (toolEntries.length <= 0) return;
    clearToolActivityBlock();
    const lines = formatTuiToolActivityBlock({
      entries: toolEntries,
      columns: terminalColumns(),
      frameIndex: frameIdx,
    });
    process.stdout.write(`\r${lines.join('\n')}`);
    toolActivityRows = lines.length;
  };
  const render = () => {
    if (stopped) return;
    if (hasVisibleText || thinkingPreviewRows > 0) return;
    if (toolEntries.length > 0) {
      repaintToolBlock(i);
      i++;
      return;
    }
    if (!showActivityPreview) return;
    clearLine();
    const frame = JELLYFISH_PULSE_FRAMES[i % JELLYFISH_PULSE_FRAMES.length];
    process.stdout.write(
      `\r  ${frame.emojiColor}${JELLYFISH}${RESET} ${frame.verbColor}${activityVerb}${RESET}`,
    );
    i++;
  };

  const clearTools = () => {
    if (toolEntries.length <= 0) return;
    clearToolActivityBlock();
    toolEntries.length = 0;
    if (
      !stopped &&
      showActivityPreview &&
      !hasVisibleText &&
      thinkingPreviewRows === 0
    ) {
      render();
    }
  };

  const clearThinkingPreview = () => {
    if (thinkingPreviewRows <= 0) return;
    for (let row = 0; row < thinkingPreviewRows; row += 1) {
      clearLine();
      if (row < thinkingPreviewRows - 1) {
        process.stdout.write('\x1b[1A');
      }
    }
    thinkingPreviewRows = 0;
    if (!stopped && showActivityPreview && !hasVisibleText) {
      render();
    }
  };

  const clearVisibleText = () => {
    if (!hasVisibleText) return;
    if (process.stdout.isTTY) {
      const rows = Math.max(1, visibleTextRows);
      if (rows > 1) process.stdout.write(`\x1b[${rows - 1}A`);
      for (let row = 0; row < rows; row += 1) {
        clearLine();
        if (row < rows - 1) process.stdout.write('\n');
      }
      if (rows > 1) process.stdout.write(`\x1b[${rows - 1}A`);
    }
    hasVisibleText = false;
    visibleTextState = createTuiStreamFormatState();
    visibleTextRows = 0;
    if (!stopped && showActivityPreview && thinkingPreviewRows === 0) {
      render();
    }
  };

  const setThinkingPreview = (preview: string | null) => {
    if (!showThinkingPreview) return;
    const normalizedPreview = String(preview || '');
    if (!normalizedPreview) {
      clearThinkingPreview();
      return;
    }
    if (hasVisibleText) return;
    if (toolEntries.length > 0) return;
    clearThinkingPreview();
    clearLine();
    const formatted = wrapTuiBlock(normalizedPreview, terminalColumns(), '  ');
    process.stdout.write(`\r${THINKING_PREVIEW_COLOR}${formatted}${RESET}`);
    thinkingPreviewRows = Math.max(1, formatted.split('\n').length);
  };

  hideCursor();
  const interval = showActivityPreview ? setInterval(render, 350) : null;
  if (showActivityPreview) render();
  return {
    stop: () => {
      stopped = true;
      if (interval) clearInterval(interval);
      if (
        toolEntries.length > 0 &&
        !hasVisibleText &&
        thinkingPreviewRows === 0
      ) {
        repaintToolBlock(i);
      }
      if (showActivityPreview && !hasVisibleText && thinkingPreviewRows === 0) {
        if (toolActivityRows > 0) {
          clearToolActivityBlock();
        } else {
          clearLine();
        }
      }
      showCursor();
    },
    addTool: (toolName: string, preview?: string) => {
      if (!showTools) return;
      if (hasVisibleText) return;
      clearThinkingPreview();
      clearLine();
      const normalizedPreview = preview || '';
      let existingEntry: SpinnerToolEntry | undefined;
      for (let idx = toolEntries.length - 1; idx >= 0; idx -= 1) {
        const entry = toolEntries[idx];
        if (entry.name !== toolName || entry.preview !== normalizedPreview) {
          continue;
        }
        existingEntry = entry;
        break;
      }
      if (existingEntry) {
        existingEntry.count += 1;
        repaintToolBlock(i);
        return;
      }
      const entry: SpinnerToolEntry = {
        name: toolName,
        preview: normalizedPreview,
        count: 1,
      };
      toolEntries.push(entry);
      repaintToolBlock(i);
    },
    finishTool: (toolName: string, preview?: string) => {
      if (!showTools) return;
      if (hasVisibleText) return;
      const normalizedPreview = preview || '';
      for (let idx = toolEntries.length - 1; idx >= 0; idx -= 1) {
        const entry = toolEntries[idx];
        if (entry.name !== toolName || entry.preview !== normalizedPreview) {
          continue;
        }
        if (entry.count > 1) {
          entry.count -= 1;
        } else {
          toolEntries.splice(idx, 1);
        }
        break;
      }
      if (toolEntries.length > 0) {
        repaintToolBlock(i);
      } else {
        clearToolActivityBlock();
        if (!stopped && showActivityPreview && thinkingPreviewRows === 0) {
          render();
        }
      }
    },
    addVisibleTextDelta: (delta: string) => {
      if (!delta) return;
      clearThinkingPreview();
      if (!hasVisibleText) {
        clearTools();
        clearLine();
      }
      const formatted = formatTuiStreamDelta(
        delta,
        visibleTextState,
        terminalColumns(),
      );
      visibleTextState = formatted.state;
      if (!formatted.text) return;
      hasVisibleText = true;
      visibleTextRows = appendTerminalRowCount(visibleTextRows, formatted.text);
      process.stdout.write(formatted.text);
    },
    flushVisibleText: () => {
      const formatted = flushTuiStreamDelta(
        visibleTextState,
        terminalColumns(),
      );
      visibleTextState = formatted.state;
      if (!formatted.text) return;
      clearThinkingPreview();
      if (!hasVisibleText) {
        clearTools();
        clearLine();
        hasVisibleText = true;
      }
      visibleTextRows = appendTerminalRowCount(visibleTextRows, formatted.text);
      process.stdout.write(formatted.text);
    },
    clearVisibleText,
    trailingNewlinesAfterVisibleText: () =>
      getTuiStreamTrailingNewlines(visibleTextState, terminalColumns()),
    setThinkingPreview,
    clearThinkingPreview,
    clearTools,
  };
}

function sessionGatewayContext(): {
  sessionId: string;
  sessionMode: 'new' | 'resume';
  guildId: null;
  channelId: string;
} {
  return {
    sessionId: tuiSessionId,
    sessionMode: tuiSessionMode,
    guildId: null,
    channelId: CHANNEL_ID,
  };
}

function summarizeGatewayMediaItems(media: GatewayMediaItem[]): string {
  if (media.length === 0) return '0 attachments';
  const preview = summarizeMediaFilenames(
    media.map((item) => item.filename || 'attachment'),
  );
  const countLabel =
    media.length === 1 ? '1 attachment' : `${media.length} attachments`;
  return `${countLabel}: ${preview}`;
}

function buildPendingMediaPromptLabel(): string | null {
  if (tuiPendingMediaUploads > 0 && tuiPendingMedia.length > 0) {
    return `${tuiPendingMedia.length} queued, uploading`;
  }
  if (tuiPendingMediaUploads > 0) {
    return 'uploading attachment';
  }
  if (tuiPendingMedia.length > 0) {
    return tuiPendingMedia.length === 1
      ? '1 attachment queued'
      : `${tuiPendingMedia.length} attachments queued`;
  }
  return null;
}

function consumePendingMedia(rl: readline.Interface): GatewayMediaItem[] {
  if (tuiPendingMedia.length === 0) return [];
  const media = tuiPendingMedia;
  tuiPendingMedia = [];
  refreshPrompt(rl);
  return media;
}

function restorePendingMedia(
  rl: readline.Interface,
  media: GatewayMediaItem[],
): void {
  if (media.length === 0) return;
  tuiPendingMedia = [...media, ...tuiPendingMedia];
  refreshPrompt(rl);
}

function buildGatewayChatRequest(
  content: string,
  media?: GatewayMediaItem[],
): {
  sessionId: string;
  sessionMode: 'new' | 'resume';
  guildId: null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  media?: GatewayMediaItem[];
} {
  return {
    ...sessionGatewayContext(),
    userId: TUI_USER_ID,
    username: TUI_USERNAME,
    content,
    ...(media && media.length > 0 ? { media } : {}),
  };
}

async function requestGatewayCommand(
  args: string[],
): Promise<GatewayCommandResult> {
  const result = await gatewayCommand({
    ...sessionGatewayContext(),
    args,
    userId: TUI_USER_ID,
    username: TUI_USERNAME,
  });
  syncTuiSessionIdFromResult(result);
  return result;
}

function stopActiveRun(): Promise<GatewayCommandResult> | null {
  activeRunStopInFlight = stopTuiRun({
    abortController: activeRunAbortController,
    stopRequest: activeRunStopInFlight,
    requestStop: () => requestGatewayCommand(['stop']),
    clearStopRequest: () => {
      activeRunStopInFlight = null;
    },
  });
  return activeRunStopInFlight;
}

function collectToolNames(result: GatewayChatResult): string[] {
  const names = new Set<string>();

  for (const execution of result.toolExecutions || []) {
    if (execution.name) names.add(execution.name);
  }

  if (names.size === 0) {
    for (const toolName of result.toolsUsed || []) {
      if (toolName) names.add(toolName);
    }
  }

  return Array.from(names);
}

function collectPluginNames(result: GatewayChatResult): string[] {
  const names = new Set<string>();

  for (const pluginName of result.pluginsUsed || []) {
    if (pluginName) names.add(pluginName);
  }

  return Array.from(names);
}

function isInterruptedResult(result: GatewayChatResult): boolean {
  const errorText = result.error || '';
  return errorText.includes('aborted') || errorText.includes('Interrupted');
}

function syncTuiSessionId(nextSessionId: string | null | undefined): void {
  const normalized = String(nextSessionId || '').trim();
  if (!normalized || normalized === tuiSessionId) return;
  tuiSessionId = normalized;
}

function syncTuiSessionIdFromResult(result: { sessionId?: string }): void {
  syncTuiSessionId(result.sessionId);
}

function buildPromptText(): string {
  const fullAutoLabel = formatTuiFullAutoPromptLabel(tuiFullAutoState);
  const pendingMediaLabel = buildPendingMediaPromptLabel();
  const separator = `${MUTED}${'─'.repeat(terminalColumns() - 2)}${RESET}`;
  const labels = [
    fullAutoLabel ? `${GOLD}[${fullAutoLabel}]${RESET}` : '',
    pendingMediaLabel ? `${MUTED}[${pendingMediaLabel}]${RESET}` : '',
  ].filter(Boolean);
  return `${separator}\n  ${labels.length > 0 ? `${labels.join(' ')} ` : ''}${TEAL}>${RESET} `;
}

function clearTuiSlashMenu(): void {
  tuiSlashMenu?.clear();
}

function setTuiLoadedPluginCommands(
  pluginCommands: GatewayPluginCommandSummary[] | undefined,
): void {
  const names = new Set<string>();
  for (const command of pluginCommands || []) {
    const normalized = String(command?.name || '')
      .trim()
      .toLowerCase();
    if (normalized) names.add(normalized);
  }
  tuiLoadedPluginCommandNames = names;
}

function syncTuiSlashMenu(): void {
  tuiSlashMenu?.sync();
}

function syncTuiSlashMenuEntries(
  pluginCommands: GatewayPluginCommandSummary[] | undefined,
): void {
  setTuiLoadedPluginCommands(pluginCommands);
  tuiSlashMenu?.setEntries(buildTuiSlashMenuEntries(pluginCommands || []));
}

function isReadlineClosed(rl: readline.Interface): boolean {
  return (rl as readline.Interface & { closed?: boolean }).closed === true;
}

function promptTuiInput(rl: readline.Interface): void {
  if (tuiExitInProgress || isReadlineClosed(rl)) return;
  clearTuiSlashMenu();
  rl.prompt();
  syncTuiSlashMenu();
}

function resetReadlinePromptRows(rl: readline.Interface): void {
  (rl as TuiReadlineInterface).prevRows = 0;
}

function refreshPrompt(rl: readline.Interface): void {
  if (tuiExitInProgress || isReadlineClosed(rl)) return;
  clearTuiSlashMenu();
  rl.setPrompt(buildPromptText());
  const internal = rl as TuiReadlineInterface;
  internal._refreshLine?.();
  syncTuiSlashMenu();
}

function parseShowModeFromResult(
  result: GatewayCommandResult,
): SessionShowMode {
  const match = result.text.match(/^Current:\s*(all|thinking|tools|none)\b/im);
  return normalizeSessionShowMode(match?.[1]);
}

async function fetchInitialShowMode(): Promise<SessionShowMode> {
  try {
    const result = await requestGatewayCommand(['show']);
    return parseShowModeFromResult(result);
  } catch {
    return DEFAULT_SESSION_SHOW_MODE;
  }
}

async function fetchInitialFullAutoState(): Promise<TuiFullAutoState> {
  try {
    const result = await requestGatewayCommand(['fullauto', 'status']);
    return parseFullAutoStatusText(result.text) || DEFAULT_TUI_FULLAUTO_STATE;
  } catch {
    return DEFAULT_TUI_FULLAUTO_STATE;
  }
}

async function fetchTuiInputHistory(
  limit = TUI_HISTORY_SIZE,
): Promise<string[]> {
  try {
    const response = await gatewayHistory(
      tuiSessionId,
      resolveTuiHistoryFetchLimit(limit),
    );
    return buildTuiReadlineHistory(response.history, limit);
  } catch {
    return [];
  }
}

async function fetchTuiExitSummary(): Promise<{
  summary: {
    inputTokenCount: number;
    outputTokenCount: number;
    costUsd: number;
    toolCallCount: number;
    toolBreakdown: Array<{ toolName: string; count: number }>;
    fileChanges: {
      readCount: number;
      modifiedCount: number;
      createdCount: number;
      deletedCount: number;
    };
  } | null;
  error: string | null;
}> {
  return fetchTuiRemoteExitSummary({
    loadRemote: async () => {
      const response = await gatewayHistory(tuiSessionId, 1, {
        summarySinceMs: tuiSessionStartedAtMs,
      });
      return response.summary || null;
    },
  });
}

async function finalizeTuiExit(): Promise<void> {
  if (tuiExitInProgress) return;
  tuiExitInProgress = true;
  clearTuiSlashMenu();
  tuiSlashMenu = null;

  const { summary, error } = await fetchTuiExitSummary();
  const durationMs = Date.now() - tuiSessionStartedAtMs;

  console.log();
  console.log();
  const summaryLines =
    summary || !error
      ? buildTuiExitSummaryLines({
          sessionId: tuiSessionId,
          durationMs,
          inputTokenCount: summary?.inputTokenCount ?? 0,
          outputTokenCount: summary?.outputTokenCount ?? 0,
          costUsd: summary?.costUsd ?? 0,
          toolCallCount: summary?.toolCallCount ?? 0,
          toolBreakdown: summary?.toolBreakdown ?? [],
          readFileCount: summary?.fileChanges.readCount ?? 0,
          modifiedFileCount: summary?.fileChanges.modifiedCount ?? 0,
          createdFileCount: summary?.fileChanges.createdCount ?? 0,
          deletedFileCount: summary?.fileChanges.deletedCount ?? 0,
          resumeCommand: tuiResumeCommand,
        })
      : buildTuiUnavailableExitSummaryLines({
          sessionId: tuiSessionId,
          durationMs,
          error,
          resumeCommand: tuiResumeCommand,
        });
  for (const line of summaryLines) {
    console.log(line);
  }
  console.log();
  process.exit(0);
}

async function syncFullAutoStateFromGateway(
  rl: readline.Interface,
): Promise<TuiFullAutoState> {
  const nextState = await fetchInitialFullAutoState();
  const changed =
    nextState.enabled !== tuiFullAutoState.enabled ||
    nextState.runtimeState !== tuiFullAutoState.runtimeState;
  tuiFullAutoState = nextState;
  if (changed) {
    refreshPrompt(rl);
  }
  return tuiFullAutoState;
}

async function runGatewayCommand(
  args: string[],
  rl: readline.Interface,
  request: Promise<GatewayCommandResult> = requestGatewayCommand(args),
): Promise<void> {
  try {
    const result = await request;
    const pendingApproval =
      result.kind === 'info' ? parseTuiApprovalPrompt(result.text || '') : null;
    if (pendingApproval) {
      await handleTuiPendingApproval(pendingApproval, rl);
      return;
    }
    printGatewayCommandResult(result);
    const normalizedCommand = (args[0] || '').trim().toLowerCase();
    const normalizedSubcommand = (args[1] || '').trim().toLowerCase();
    if (
      normalizedCommand === 'plugin' &&
      (normalizedSubcommand === 'enable' ||
        normalizedSubcommand === 'disable' ||
        normalizedSubcommand === 'install' ||
        normalizedSubcommand === 'reinstall' ||
        normalizedSubcommand === 'reload' ||
        normalizedSubcommand === 'uninstall')
    ) {
      try {
        const status = await gatewayStatus();
        syncTuiSlashMenuEntries(status.pluginCommands);
      } catch {
        // Keep the existing menu entries when refresh fails.
      }
    }
    if (normalizedCommand === 'show') {
      tuiShowMode = isSessionShowMode(normalizedSubcommand)
        ? normalizedSubcommand
        : parseShowModeFromResult(result);
    }
    const nextFullAutoState = deriveTuiFullAutoState({
      current: tuiFullAutoState,
      args,
      result,
    });
    const fullAutoJustEnabled =
      !tuiFullAutoState.enabled && nextFullAutoState.enabled;
    tuiFullAutoState = nextFullAutoState;
    refreshPrompt(rl);
    if (
      fullAutoJustEnabled &&
      normalizedCommand === 'fullauto' &&
      normalizedSubcommand !== 'status' &&
      normalizedSubcommand !== 'info'
    ) {
      printInfo(
        'Full-auto armed. First background turn starts in about 3 seconds.',
      );
    }
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}

function parseCurrentModelFromInfo(
  result: GatewayCommandResult,
): string | null {
  const info = parseModelInfoFromInfo(result);
  return info?.current || null;
}

function getDisplayedDefaultHybridAIModel(): string {
  return formatModelForDisplay(HYBRIDAI_MODEL);
}

function parseModelInfoFromInfo(
  result: GatewayCommandResult,
): { current: string; defaultModel: string } | null {
  const parsed = parseModelInfoSummaryFromText(result.text || '');
  if (!parsed) return null;
  return {
    current:
      parsed.current ||
      parsed.defaultModel ||
      getDisplayedDefaultHybridAIModel(),
    defaultModel:
      parsed.defaultModel ||
      parsed.current ||
      getDisplayedDefaultHybridAIModel(),
  };
}

async function fetchCurrentSessionModel(): Promise<string | null> {
  try {
    const result = await requestGatewayCommand(['model', 'info']);
    if (result.kind === 'error') return null;
    return parseCurrentModelFromInfo(result);
  } catch {
    return null;
  }
}

async function fetchSelectableModels(): Promise<
  Array<{ label: string; value: string; isFree: boolean; recommended: boolean }>
> {
  const fallback = sortSelectableModelEntries(
    normalizeModelCandidates([HYBRIDAI_MODEL]).map((model) => ({
      label: formatModelForDisplay(model),
      value: model,
      isFree: false,
      recommended: false,
    })),
  );
  try {
    const result = await requestGatewayCommand(['model', 'list']);
    if (result.kind === 'error') return fallback;
    if (Array.isArray(result.modelCatalog) && result.modelCatalog.length > 0) {
      const seen = new Set<string>();
      const models: Array<{
        label: string;
        value: string;
        isFree: boolean;
        recommended: boolean;
      }> = [];
      for (const entry of result.modelCatalog) {
        const value = String(entry.value || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        models.push({
          label:
            String(entry.label || '').trim() || formatModelForDisplay(value),
          value,
          isFree: entry.isFree === true,
          recommended: entry.recommended === true,
        });
      }
      return models.length > 0 ? sortSelectableModelEntries(models) : fallback;
    }
    const models = parseModelNamesFromListText(result.text || '');
    return models.length > 0
      ? sortSelectableModelEntries(
          models.map((model) => ({
            label: model,
            value: model,
            isFree: false,
            recommended: false,
          })),
        )
      : fallback;
  } catch {
    return fallback;
  }
}

async function fetchSessionAndDefaultModel(): Promise<{
  current: string;
  defaultModel: string;
}> {
  const fallback = {
    current: getDisplayedDefaultHybridAIModel(),
    defaultModel: getDisplayedDefaultHybridAIModel(),
  };
  try {
    const result = await requestGatewayCommand(['model', 'info']);
    if (result.kind === 'error') return fallback;
    return parseModelInfoFromInfo(result) || fallback;
  } catch {
    return fallback;
  }
}

async function promptModelSelection(
  rl: readline.Interface,
): Promise<string | null> {
  clearTuiSlashMenu();
  const models = await fetchSelectableModels();
  if (models.length === 0) {
    printError('No models configured.');
    return null;
  }

  const currentModel = await fetchCurrentSessionModel();
  console.log(`  ${BOLD}${GOLD}Model selector${RESET}`);
  if (currentModel) {
    const currentEntry = models.find((entry) => entry.label === currentModel);
    const currentColor = currentEntry?.recommended
      ? LIGHT_GREEN
      : currentEntry?.isFree === true
        ? GREEN
        : TEAL;
    const currentMarker = currentEntry?.recommended ? '★ ' : '';
    console.log(
      `  ${MUTED}Current:${RESET} ${currentColor}${currentMarker}${currentModel}${RESET}`,
    );
  }
  for (const [index, entry] of models.entries()) {
    const suffix =
      currentModel === entry.label ? ` ${MUTED}(current)${RESET}` : '';
    const marker = entry.recommended ? `${LIGHT_GREEN}★ ${RESET}` : '';
    const modelColor = entry.recommended
      ? LIGHT_GREEN
      : entry.isFree
        ? GREEN
        : RESET;
    console.log(
      `  ${TEAL}${index + 1}${RESET} ${marker}${modelColor}${entry.label}${RESET}${suffix}`,
    );
  }

  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `  ${MUTED}Select 1-${models.length} (Enter to cancel):${RESET} `,
      resolve,
    );
  });
  const trimmed = answer.trim();
  if (!trimmed) return null;

  const asNumber = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= models.length) {
    return models[asNumber - 1]?.value || null;
  }
  const matchedEntry = models.find(
    (entry) =>
      entry.label === trimmed ||
      entry.value === trimmed ||
      entry.value ===
        formatHybridAIModelForCatalog(
          normalizeHybridAIModelForRuntime(trimmed),
        ),
  );
  if (matchedEntry) return matchedEntry.value;

  printInfo('Invalid model selection.');
  return null;
}

async function promptSkillConfigSelection(
  rl: readline.Interface,
): Promise<void> {
  clearTuiSlashMenu();
  const response = await fetchGatewayAdminSkills();
  if (response.skills.length === 0) {
    printInfo('No skills found.');
    return;
  }

  const result = await promptTuiSkillConfig({
    rl,
    response,
    saveMutation: saveGatewayAdminSkillEnabled,
  });

  if (result.cancelled) {
    printInfo('Skill config cancelled.');
    return;
  }
  if (result.savedCount === 0) {
    printInfo('No skill config changes saved.');
    return;
  }
  printInfo(
    `Saved ${result.savedCount} skill change${result.savedCount === 1 ? '' : 's'} across ${result.changedScopeCount} scope${result.changedScopeCount === 1 ? '' : 's'}.`,
  );
}

async function handleSlashCommand(
  input: string,
  rl: readline.Interface,
): Promise<boolean> {
  const parsed = parseTuiSlashCommand(input);
  const parts = parsed.parts;
  const cmd = parsed.cmd;

  switch (cmd) {
    case 'help':
      printHelp();
      return true;
    case 'paste':
      await handleTuiClipboardPaste(rl);
      return true;
    case 'exit':
    case 'quit':
    case 'q':
      clearTuiSlashMenu();
      rl.close();
      return true;
    case 'model':
      if (parts.length === 1 || parts[1] === 'select') {
        const selectedModel = await promptModelSelection(rl);
        if (selectedModel) {
          await runGatewayCommand(['model', 'set', selectedModel], rl);
        }
        return true;
      }
      {
        const gatewayArgs = mapTuiSlashCommandToGatewayArgs(parts);
        if (gatewayArgs) {
          await runGatewayCommand(gatewayArgs, rl);
          return true;
        }
      }
      if (parts.length > 1) {
        await runGatewayCommand(['model', 'set', ...parts.slice(1)], rl);
        return true;
      }
      return true;
    case 'approve': {
      const action = (parts[1] || 'view').trim().toLowerCase();
      if (action === 'view' || action === 'status' || action === 'show') {
        if (!tuiPendingApproval) {
          printInfo('No pending approval request cached in this TUI session.');
          return true;
        }
        const requestedId = (parts[2] || '').trim();
        if (requestedId && requestedId !== tuiPendingApproval.requestId) {
          printInfo(
            `No cached approval prompt for request ${requestedId}. Current pending request: ${tuiPendingApproval.requestId}`,
          );
          return true;
        }
        printInfo(tuiPendingApproval.summary);
        return true;
      }

      const approvalResult = mapTuiApproveSlashToMessage(
        parts,
        tuiPendingApproval?.requestId,
      );
      if (approvalResult.kind === 'usage') {
        printInfo(`Usage: ${APPROVE_COMMAND_USAGE}`);
        return true;
      }
      if (approvalResult.kind === 'missing-approval') {
        printInfo('No pending approval request is available to approve.');
        return true;
      }
      await submitApprovalReplay(approvalResult.message, rl);
      return true;
    }
    case 'skill': {
      const subcommand = (parts[1] || '').trim().toLowerCase();
      if (subcommand !== 'config') break;
      if (parts.length > 2) {
        printInfo('Usage: /skill config');
        return true;
      }
      await promptSkillConfigSelection(rl);
      return true;
    }
    case 'info':
      await runGatewayCommand(['bot', 'info'], rl);
      await runGatewayCommand(['model', 'info'], rl);
      await runGatewayCommand(['status'], rl);
      return true;
    case 'stop':
    case 'abort': {
      const stopRequest = stopActiveRun();
      if (stopRequest) {
        printInfo('Stopping current request and disabling full-auto...');
      } else {
        printInfo('No active foreground request. Disabling full-auto...');
      }
      await runGatewayCommand(['stop'], rl, stopRequest ?? undefined);
      return true;
    }
    default:
      break;
  }

  const gatewayArgs = mapTuiSlashCommandToGatewayArgs(parts, {
    dynamicTextCommands: tuiLoadedPluginCommandNames,
  });
  if (gatewayArgs) {
    await runGatewayCommand(gatewayArgs, rl);
    return true;
  }

  return false;
}

async function processMessage(
  content: string,
  rl: readline.Interface,
): Promise<void> {
  if (shouldRouteTuiInputToFullAuto(tuiFullAutoState)) {
    await processFullAutoSteeringMessage(content, rl);
    return;
  }

  tuiShowMode = await fetchInitialShowMode();
  process.stdout.write('\n');
  const s = spinner();
  const abortController = new AbortController();
  activeRunAbortController = abortController;
  const queuedMedia = consumePendingMedia(rl);
  let sawResponse = queuedMedia.length === 0;

  try {
    const request = buildGatewayChatRequest(content, queuedMedia);
    const streamState = createTuiThinkingStreamState();
    const streamedToolNames = new Set<string>();
    const activeDisplayedToolStartCounts = new Map<string, number>();
    const hiddenDuplicateToolCounts = new Map<string, number>();
    const makeToolDisplayKey = (toolName: string, preview: string): string =>
      `${toolName}\0${preview}`;
    let sawStreamEvent = false;
    let sawVisibleTextDelta = false;
    let activeDelegateToolCount = 0;
    let streamedApproval: GatewayChatApprovalEvent | null = null;
    let result: GatewayChatResult;

    try {
      result = await gatewayChatStream(
        {
          ...request,
          stream: true,
        },
        (event) => {
          if (event.type === 'text') {
            sawStreamEvent = true;
            if (activeDelegateToolCount > 0) return;
            sawResponse = true;
            const streamed = streamState.push(event.delta);
            if (streamed.visibleDelta) {
              sawVisibleTextDelta = true;
              s.addVisibleTextDelta(streamed.visibleDelta);
            } else if (streamed.thinkingPreview) {
              s.setThinkingPreview(streamed.thinkingPreview);
            }
            return;
          }
          if (event.type === 'thinking') {
            sawStreamEvent = true;
            sawResponse = true;
            const streamed = streamState.pushThinking(event.delta);
            if (!sawVisibleTextDelta && streamed.thinkingPreview) {
              s.setThinkingPreview(streamed.thinkingPreview);
            }
            return;
          }
          if (event.type === 'approval') {
            sawStreamEvent = true;
            sawResponse = true;
            streamedApproval = event;
            return;
          }
          if (event.type !== 'tool' || !event.toolName) return;
          sawStreamEvent = true;
          sawResponse = true;
          if (
            event.toolName === 'delegate' &&
            event.phase === 'start' &&
            activeDelegateToolCount === 0
          ) {
            if (sawVisibleTextDelta) {
              s.clearVisibleText();
              sawVisibleTextDelta = false;
            }
          }
          activeDelegateToolCount = nextActiveDelegateToolCount(
            activeDelegateToolCount,
            event,
          );
          if (event.phase === 'finish') {
            const previewText = formatToolPreview(event.preview);
            const displayKey = makeToolDisplayKey(event.toolName, previewText);
            const hiddenCount = hiddenDuplicateToolCounts.get(displayKey) || 0;
            if (hiddenCount > 0) {
              if (hiddenCount === 1) {
                hiddenDuplicateToolCounts.delete(displayKey);
              } else {
                hiddenDuplicateToolCounts.set(displayKey, hiddenCount - 1);
              }
              return;
            }
            s.finishTool(event.toolName, previewText || undefined);
            const activeDisplayCount =
              activeDisplayedToolStartCounts.get(displayKey) || 0;
            if (activeDisplayCount <= 1) {
              activeDisplayedToolStartCounts.delete(displayKey);
            } else {
              activeDisplayedToolStartCounts.set(
                displayKey,
                activeDisplayCount - 1,
              );
            }
            return;
          }
          if (event.phase !== 'start') return;
          const previewText = formatToolPreview(event.preview);
          const displayKey = makeToolDisplayKey(event.toolName, previewText);
          streamedToolNames.add(event.toolName);
          const activeDisplayCount =
            activeDisplayedToolStartCounts.get(displayKey) || 0;
          if (activeDisplayCount > 0) {
            hiddenDuplicateToolCounts.set(
              displayKey,
              (hiddenDuplicateToolCounts.get(displayKey) || 0) + 1,
            );
            return;
          }
          activeDisplayedToolStartCounts.set(
            displayKey,
            activeDisplayCount + 1,
          );
          s.addTool(event.toolName, previewText || undefined);
        },
        abortController.signal,
      );
    } catch (streamErr) {
      if (abortController.signal.aborted) {
        throw streamErr;
      }
      if (sawStreamEvent) {
        throw streamErr;
      }
      result = await gatewayChat(request, abortController.signal);
    }
    sawResponse = true;
    syncTuiSessionIdFromResult(result);

    const toolNames = [
      ...new Set([...streamedToolNames, ...collectToolNames(result)]),
    ];
    const pluginNames = collectPluginNames(result);
    const skillName = result.skillUsed;
    const hasUsageFooters =
      toolNames.length > 0 || pluginNames.length > 0 || !!skillName;
    const hasStreamedText = sawVisibleTextDelta;
    const finalText = result.result || 'No response.';
    const pendingApproval = resolvePendingApproval(
      result,
      streamedApproval,
      resolveCachedApprovalDetails(tuiPendingApproval),
    );

    s.flushVisibleText();
    s.stop();
    s.clearThinkingPreview();
    const streamedResponseTrailingNewlines = hasStreamedText
      ? s.trailingNewlinesAfterVisibleText()
      : '';
    if (hasUsageFooters) {
      if (!hasStreamedText) {
        s.clearTools();
      } else {
        process.stdout.write(streamedResponseTrailingNewlines);
      }
      printUsageFooter(toolNames, pluginNames, skillName);
    }

    if (isInterruptedResult(result)) {
      if (hasStreamedText) {
        console.log();
      }
      return;
    }

    if (result.status === 'error') {
      if (hasStreamedText) {
        process.stdout.write('\n');
      }
      printError(result.error || 'Unknown error', {
        leadingBlank: false,
      });
      return;
    }

    if (pendingApproval) {
      await handleTuiPendingApproval(pendingApproval, rl);
    } else {
      if (isApprovalResponseContent(content)) {
        tuiPendingApproval = null;
      }
      if (hasStreamedText) {
        // After usage footers, only a single newline is needed because the
        // blank line after the streamed response was already written above.
        process.stdout.write(
          hasUsageFooters ? '\n' : streamedResponseTrailingNewlines,
        );
      } else {
        printResponse(finalText, {
          leadingBlank: hasUsageFooters,
        });
      }
    }
  } catch (err) {
    s.flushVisibleText();
    s.stop();
    if (!sawResponse) {
      restorePendingMedia(rl, queuedMedia);
    }
    if (abortController.signal.aborted) return;
    s.clearThinkingPreview();
    process.stdout.write('\n');
    printError(err instanceof Error ? err.message : String(err), {
      leadingBlank: false,
    });
  } finally {
    s.clearThinkingPreview();
    s.clearTools();
    if (activeRunAbortController === abortController) {
      activeRunAbortController = null;
      void pollProactiveMessages(rl, {
        promptAfter: false,
        promptVisible: false,
      });
    }
  }
}

async function processFullAutoSteeringMessage(
  content: string,
  rl: readline.Interface,
): Promise<void> {
  if (fullAutoSteeringInFlight) {
    printInfo(
      'Full-auto is already handling a steering note. Wait for the reply or use /stop to interrupt it.',
    );
    return;
  }

  const abortController = new AbortController();
  activeRunAbortController = abortController;
  fullAutoSteeringInFlight = true;
  const queuedMedia = consumePendingMedia(rl);
  let sawResponse = queuedMedia.length === 0;
  tuiFullAutoState = {
    ...tuiFullAutoState,
    runtimeState: 'steering',
  };
  refreshPrompt(rl);
  printInfo('Sent guidance to full-auto. Reply will arrive asynchronously.');

  void (async () => {
    try {
      const result = await gatewayChat(
        buildGatewayChatRequest(content, queuedMedia),
        abortController.signal,
      );
      sawResponse = true;
      syncTuiSessionIdFromResult(result);
      if (isInterruptedResult(result)) {
        return;
      }
      if (result.status === 'error') {
        printError(result.error || 'Unknown error');
        return;
      }
      const pendingApproval = resolvePendingApproval(
        result,
        null,
        resolveCachedApprovalDetails(tuiPendingApproval),
      );
      if (pendingApproval) {
        await handleTuiPendingApproval(pendingApproval, rl);
        return;
      }
      printResponse(result.result || 'No response.');
    } catch (err) {
      if (!sawResponse) {
        restorePendingMedia(rl, queuedMedia);
      }
      if (abortController.signal.aborted) return;
      printError(err instanceof Error ? err.message : String(err));
    } finally {
      fullAutoSteeringInFlight = false;
      if (activeRunAbortController === abortController) {
        activeRunAbortController = null;
      }
      if (tuiFullAutoState.enabled) {
        tuiFullAutoState = {
          ...tuiFullAutoState,
          runtimeState: 'running',
        };
      }
      refreshPrompt(rl);
      promptTuiInput(rl);
    }
  })();
}

function isDelegateStatusMessage(text: string): boolean {
  return text.trimStart().startsWith('[Delegate Status]');
}

export function nextActiveDelegateToolCount(
  activeCount: number,
  event: { toolName?: string | null; phase?: string | null },
): number {
  if (event.toolName !== 'delegate') return activeCount;
  if (event.phase === 'start') return activeCount + 1;
  if (event.phase === 'finish') return Math.max(0, activeCount - 1);
  return activeCount;
}

function isDelegateStreamSource(source: string): boolean {
  return String(source || '').startsWith('delegate:stream:');
}

function handleDelegateStreamMessage(message: {
  text: string;
  source: string;
}): boolean {
  const source = String(message.source || '');
  if (!isDelegateStreamSource(source)) return false;

  if (source === 'delegate:stream:start') {
    delegateStreamActive = true;
    delegateStreamFormatState = createTuiStreamFormatState();
    return true;
  }

  if (source === 'delegate:stream:delta') {
    if (!delegateStreamActive) {
      delegateStreamActive = true;
      delegateStreamFormatState = createTuiStreamFormatState();
    }
    const formatted = formatTuiStreamDelta(
      message.text,
      delegateStreamFormatState,
      terminalColumns(),
    );
    delegateStreamFormatState = formatted.state;
    if (formatted.text) process.stdout.write(formatted.text);
    return true;
  }

  if (source === 'delegate:stream:end') {
    if (delegateStreamActive) {
      const flushed = flushTuiStreamDelta(
        delegateStreamFormatState,
        terminalColumns(),
      );
      delegateStreamFormatState = flushed.state;
      if (flushed.text) process.stdout.write(flushed.text);
    }
    delegateStreamActive = false;
    delegateStreamFormatState = createTuiStreamFormatState();
    return true;
  }

  return true;
}

function clearDelegateStatusBlock(): void {
  if (delegateStatusRows <= 0) return;
  clearTerminalRows(delegateStatusRows, delegateStatusRows);
  delegateStatusRows = 0;
}

function currentPromptRows(): number {
  return countTerminalRows(stripAnsiTui(buildPromptText()), terminalColumns());
}

function clearTerminalRows(rows: number, moveUpRows: number): void {
  if (rows <= 0) return;
  if (moveUpRows > 0) process.stdout.write(`\x1b[${moveUpRows}A`);
  for (let row = 0; row < rows; row += 1) {
    process.stdout.write('\r\x1b[2K');
    if (row < rows - 1) process.stdout.write('\n');
  }
  if (rows > 1) process.stdout.write(`\x1b[${rows - 1}A`);
}

function clearPromptBlockForDelegateStatus(): void {
  if (!process.stdout.isTTY) return;
  const promptRows = currentPromptRows();
  clearTerminalRows(promptRows, Math.max(0, promptRows - 1));
}

function clearDelegateStatusAndPromptBlock(): void {
  if (!process.stdout.isTTY || delegateStatusRows <= 0) {
    clearPromptBlockForDelegateStatus();
    return;
  }
  const promptRows = currentPromptRows();
  const rowsToClear = delegateStatusRows + promptRows;
  clearTerminalRows(rowsToClear, rowsToClear - 1);
  delegateStatusRows = 0;
}

function printDelegateStatusBlock(text: string, promptVisible: boolean): void {
  if (promptVisible) {
    clearDelegateStatusAndPromptBlock();
  } else {
    clearDelegateStatusBlock();
  }
  const body = text.replace(/^\[Delegate Status\]\s*/, '').trim();
  const rendered = formatTuiOutput(body);
  console.log(rendered);
  delegateStatusRows = countTerminalRows(rendered, terminalColumns());
}

function renderLatestProactiveDelegateStatus(
  rl: readline.Interface,
  message: GatewayProactiveMessage | undefined,
  promptVisible: boolean,
): void {
  if (!message) return;
  printDelegateStatusBlock(message.text, promptVisible);
  resetReadlinePromptRows(rl);
}

function prepareProactiveRegularMessageOutput(
  rl: readline.Interface,
  hasDelegateStatus: boolean,
  promptVisible: boolean,
): void {
  if (!hasDelegateStatus && promptVisible) {
    clearPromptBlockForDelegateStatus();
    resetReadlinePromptRows(rl);
  }
  console.log();
}

function renderProactiveRegularMessage(
  message: GatewayProactiveMessage,
): boolean {
  if (handleDelegateStreamMessage(message)) return true;

  const badge = proactiveBadgeLabel(message.source);
  const suffix = proactiveSourceSuffix(message.source);
  const sourceSuffix = suffix ? ` ${MUTED}${suffix}${RESET}` : '';
  if (badge === 'delegate') {
    console.log(`${formatTuiOutput(message.text)}${sourceSuffix}`);
    return false;
  }
  const badgePrefix = badge ? `  ${GOLD}[${badge}]${RESET}` : '  >';
  console.log(badgePrefix);
  console.log();
  console.log(`${formatTuiOutput(message.text)}${sourceSuffix}`);
  return false;
}

function renderProactiveRegularMessages(
  messages: GatewayProactiveMessage[],
): boolean {
  let sawDelegateStreamMessage = false;
  for (const message of messages) {
    if (renderProactiveRegularMessage(message)) {
      sawDelegateStreamMessage = true;
    }
  }
  return sawDelegateStreamMessage;
}

function restorePromptAfterProactiveMessages(
  rl: readline.Interface,
  promptAfter: boolean,
  sawDelegateStreamMessage: boolean,
): void {
  if (!promptAfter) return;
  if (!delegateStreamActive || !sawDelegateStreamMessage) {
    promptTuiInput(rl);
  }
}

async function pollProactiveMessages(
  rl: readline.Interface,
  options: { promptAfter?: boolean; promptVisible?: boolean } = {},
): Promise<void> {
  if (proactivePollInFlight) return;
  if (activeRunAbortController && !activeRunAbortController.signal.aborted)
    return;
  const promptAfter = options.promptAfter !== false;
  const promptVisible = options.promptVisible !== false;

  proactivePollInFlight = true;
  try {
    const result = await gatewayPullProactive(
      CHANNEL_ID,
      TUI_PROACTIVE_PULL_LIMIT,
    );
    if (!Array.isArray(result.messages) || result.messages.length === 0) return;

    clearTuiSlashMenu();
    const regularMessages = result.messages.filter(
      (message) =>
        !isDelegateStatusMessage(message.text) ||
        isDelegateStreamSource(message.source),
    );
    let latestDelegateStatus: GatewayProactiveMessage | undefined;
    for (let idx = result.messages.length - 1; idx >= 0; idx -= 1) {
      const message = result.messages[idx];
      if (message && isDelegateStatusMessage(message.text)) {
        latestDelegateStatus = message;
        break;
      }
    }

    renderLatestProactiveDelegateStatus(
      rl,
      latestDelegateStatus,
      promptVisible,
    );

    if (regularMessages.length === 0) {
      if (promptAfter) promptTuiInput(rl);
      return;
    }

    prepareProactiveRegularMessageOutput(
      rl,
      Boolean(latestDelegateStatus),
      promptVisible,
    );
    const sawDelegateStreamMessage =
      renderProactiveRegularMessages(regularMessages);
    if (!delegateStreamActive) {
      console.log();
    }
    restorePromptAfterProactiveMessages(
      rl,
      promptAfter,
      sawDelegateStreamMessage,
    );
    if (!delegateStreamActive) {
      return;
    }
  } catch (error) {
    logger.debug(
      { error },
      'Failed to poll proactive messages for TUI channel',
    );
  } finally {
    proactivePollInFlight = false;
  }
}

async function main(): Promise<void> {
  logger.level = 'warn';
  const status = await gatewayStatus();
  const modelInfo = await fetchSessionAndDefaultModel();
  tuiFullAutoState = await fetchInitialFullAutoState();
  tuiShowMode = await fetchInitialShowMode();
  const skillCategories = await fetchStartupSkillCategories();
  printBanner(modelInfo, status.sandbox?.mode || 'container', skillCategories);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPromptText(),
    // Keep lone ESC responsive while still allowing readline to recognize
    // multi-byte escape sequences like arrows.
    escapeCodeTimeout: TUI_ESCAPE_CODE_TIMEOUT_MS,
    historySize: TUI_HISTORY_SIZE,
  });
  (rl as TuiReadlineInterface).history =
    await fetchTuiInputHistory(TUI_HISTORY_SIZE);
  const slashMenuPalette: TuiSlashMenuPalette = {
    reset: RESET,
    separator: MUTED,
    marker: MUTED,
    markerSelected: GOLD,
    command: MUTED,
    commandSelected: `${BOLD}${TEAL}`,
    description: MUTED,
    descriptionSelected: TEAL,
  };
  const multilineInputController = new TuiMultilineInputController({
    rl,
    onPasteShortcut: () => {
      void handleTuiClipboardPaste(rl);
    },
  });
  multilineInputController.install();
  tuiSlashMenu = new TuiSlashMenuController({
    rl,
    entries: buildTuiSlashMenuEntries(status.pluginCommands || []),
    palette: slashMenuPalette,
    shouldShow: () =>
      !activeRunAbortController || activeRunAbortController.signal.aborted,
  });
  setTuiLoadedPluginCommands(status.pluginCommands);
  tuiSlashMenu.install();
  const exitController = new TuiExitController({
    rl,
    exitWindowMs: TUI_EXIT_CONFIRM_WINDOW_MS,
    onWarn: () => {
      printInfo(formatTuiExitWarning(TUI_EXIT_CONFIRM_WINDOW_MS));
      refreshPrompt(rl);
    },
    onExit: () => {
      clearTuiSlashMenu();
      rl.close();
    },
  });
  exitController.install();
  refreshPrompt(rl);

  readline.emitKeypressEvents(process.stdin, rl);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_str, key) => {
    if (key?.name !== 'escape') return;
    const stopRequest = stopActiveRun();
    if (!stopRequest) return;
    void stopRequest
      .then((result) => {
        tuiFullAutoState = deriveTuiFullAutoState({
          current: tuiFullAutoState,
          args: ['stop'],
          result,
        });
        refreshPrompt(rl);
      })
      .catch(() => {});
  });

  promptTuiInput(rl);
  let pendingInputLines: string[] = [];
  let pendingInputTimer: ReturnType<typeof setTimeout> | null = null;
  let inputRunQueue = Promise.resolve();

  const enqueueInput = (input: string): void => {
    inputRunQueue = inputRunQueue
      .then(async () => {
        const trimmed = input.trim();
        const hasPendingMedia = tuiPendingMedia.length > 0;
        clearTuiSlashMenu();
        if (!trimmed && !hasPendingMedia) {
          promptTuiInput(rl);
          return;
        }
        if (tuiPendingMediaUploads > 0) {
          printInfo('Wait for attachment uploads to finish before sending.');
          promptTuiInput(rl);
          return;
        }
        if (!input.includes('\n') && trimmed.startsWith('/')) {
          const handled = await handleSlashCommand(trimmed, rl);
          if (handled) {
            promptTuiInput(rl);
            return;
          }
        }
        if (shouldRouteTuiInputToFullAuto(tuiFullAutoState)) {
          const liveFullAutoState = await syncFullAutoStateFromGateway(rl);
          if (shouldRouteTuiInputToFullAuto(liveFullAutoState)) {
            await processFullAutoSteeringMessage(input, rl);
            promptTuiInput(rl);
            return;
          }
        }
        if (shouldRouteTuiInputToFullAuto(tuiFullAutoState)) {
          await processFullAutoSteeringMessage(input, rl);
          promptTuiInput(rl);
          return;
        }
        await processMessage(input, rl);
        promptTuiInput(rl);
      })
      .catch((err) => {
        printError(err instanceof Error ? err.message : String(err));
        promptTuiInput(rl);
      });
  };

  const flushPendingInput = (): void => {
    if (pendingInputTimer) {
      clearTimeout(pendingInputTimer);
      pendingInputTimer = null;
    }
    if (pendingInputLines.length === 0) return;
    const combined = multilineInputController.normalizeSubmittedInput(
      pendingInputLines.join('\n'),
    );
    pendingInputLines = [];
    enqueueInput(combined);
  };

  rl.on('line', (line) => {
    pendingInputLines.push(line);
    if (pendingInputTimer) clearTimeout(pendingInputTimer);
    pendingInputTimer = setTimeout(
      flushPendingInput,
      TUI_MULTILINE_PASTE_DEBOUNCE_MS,
    );
  });

  const proactivePollTimer = setInterval(() => {
    void pollProactiveMessages(rl);
  }, TUI_PROACTIVE_POLL_INTERVAL_MS);
  void pollProactiveMessages(rl);

  rl.on('close', () => {
    clearInterval(proactivePollTimer);
    if (pendingInputTimer) clearTimeout(pendingInputTimer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    void finalizeTuiExit();
  });
}

export async function runTui(options?: Partial<TuiRunOptions>): Promise<void> {
  registerChannel({
    kind: 'tui',
    id: CHANNEL_ID,
    capabilities: TUI_CAPABILITIES,
  });
  const sessionId = String(options?.sessionId || '').trim();
  tuiSessionId = sessionId || generateTuiSessionId();
  tuiSessionMode = options?.sessionMode === 'resume' ? 'resume' : 'new';
  tuiSessionStartedAtMs =
    typeof options?.startedAtMs === 'number' &&
    Number.isFinite(options.startedAtMs)
      ? Math.max(0, Math.floor(options.startedAtMs))
      : Date.now();
  tuiPendingMedia = [];
  tuiPendingMediaUploads = 0;
  tuiClipboardPasteInFlight = false;
  tuiResumeCommand =
    String(options?.resumeCommand || 'hybridclaw tui --resume').trim() ||
    'hybridclaw tui --resume';
  activeRunAbortController = null;
  activeRunStopInFlight = null;
  proactivePollInFlight = false;
  tuiFullAutoState = DEFAULT_TUI_FULLAUTO_STATE;
  fullAutoSteeringInFlight = false;
  tuiPendingApproval = null;
  tuiShowMode = DEFAULT_SESSION_SHOW_MODE;
  tuiSlashMenu = null;
  tuiExitInProgress = false;
  await main();
}
