/**
 * HybridClaw TUI — thin client for the gateway API.
 * Usage: npm run tui
 */
import readline from 'node:readline';
import { TUI_CAPABILITIES } from './channels/channel.js';
import { registerChannel } from './channels/channel-registry.js';
import {
  APP_VERSION,
  CONFIGURED_MODELS,
  GATEWAY_BASE_URL,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_MODEL,
} from './config/config.js';
import { extractGatewayChatApprovalEvent } from './gateway/chat-approval.js';
import {
  type GatewayChatApprovalEvent,
  type GatewayChatResult,
  type GatewayCommandResult,
  gatewayChat,
  gatewayChatStream,
  gatewayCommand,
  gatewayHistory,
  gatewayPullProactive,
  gatewayStatus,
  renderGatewayCommand,
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
import {
  normalizeModelCandidates,
  parseModelInfoSummaryFromText,
  parseModelNamesFromListText,
} from './model-selection.js';
import {
  formatTuiApprovalSummary,
  parseTuiApprovalPrompt,
  type TuiApprovalDetails,
} from './tui-approval.js';
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
import { proactiveBadgeLabel, proactiveSourceSuffix } from './tui-proactive.js';
import {
  buildTuiExitSummaryLines,
  generateTuiSessionId,
  type TuiRunOptions,
} from './tui-session.js';
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
import {
  countTerminalRows,
  createTuiStreamFormatState,
  createTuiThinkingStreamState,
  flushTuiStreamDelta,
  formatTuiStreamDelta,
  wrapTuiBlock,
} from './tui-thinking.js';
import type { SessionShowMode } from './types.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const JELLYFISH = '🪼';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

type TuiTheme = 'dark' | 'light';
type TuiReadlineInterface = readline.Interface & {
  history: string[];
  _refreshLine?: () => void;
};

interface TuiPalette {
  muted: string;
  teal: string;
  navy: string;
  gold: string;
  green: string;
  red: string;
}

const DARK_PALETTE: TuiPalette = {
  muted: '\x1b[38;2;170;184;204m',
  teal: '\x1b[38;2;92;224;216m',
  navy: '\x1b[38;2;30;58;95m',
  gold: '\x1b[38;2;255;215;0m',
  green: '\x1b[38;2;16;185;129m',
  red: '\x1b[38;2;239;68;68m',
};

const LIGHT_PALETTE: TuiPalette = {
  muted: '\x1b[38;2;88;99;116m',
  teal: '\x1b[38;2;0;122;128m',
  navy: '\x1b[38;2;30;58;95m',
  gold: '\x1b[38;2;138;97;0m',
  green: '\x1b[38;2;0;130;92m',
  red: '\x1b[38;2;185;28;28m',
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
const NAVY = PALETTE.navy;
const GOLD = PALETTE.gold;
const GREEN = PALETTE.green;
const RED = PALETTE.red;
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
// Keep lone ESC responsive for local TUI use. This is lower than readline's
// default and can misclassify multi-byte escape sequences on high-latency SSH
// links if arrow-key bytes arrive too far apart, so raise it here if operators
// report flaky cursor keys on slow connections.
const TUI_ESCAPE_CODE_TIMEOUT_MS = 10;
const TUI_PROACTIVE_POLL_INTERVAL_MS = Math.max(
  500,
  parseInt(process.env.TUI_PROACTIVE_POLL_INTERVAL_MS || '2500', 10) || 2500,
);
const TUI_HISTORY_SIZE = 100;
const TOOL_PREVIEW_MAX_CHARS = 140;

let activeRunAbortController: AbortController | null = null;
let proactivePollInFlight = false;
let tuiFullAutoState: TuiFullAutoState = DEFAULT_TUI_FULLAUTO_STATE;
let fullAutoSteeringInFlight = false;
let tuiPendingApproval: {
  requestId: string;
  summary: string;
  intent: string;
  reason: string;
  allowSession: boolean;
  allowAgent: boolean;
} | null = null;
let tuiShowMode: SessionShowMode = DEFAULT_SESSION_SHOW_MODE;
let tuiSlashMenu: TuiSlashMenuController | null = null;
let tuiSessionId = generateTuiSessionId();
let tuiSessionMode: 'new' | 'resume' = 'new';
let tuiSessionStartedAtMs = Date.now();
let tuiResumeCommand = 'hybridclaw tui --resume';
let tuiExitInProgress = false;

function mapApprovalSelectionToCommand(
  selection: string,
  requestId: string,
  options: Array<'once' | 'session' | 'agent' | 'skip'>,
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
  if (normalized === 'no' || normalized === 'n' || normalized === 'skip') {
    return `skip ${requestId}`;
  }
  return null;
}

function isApprovalResponseContent(content: string): boolean {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  return /^(yes|skip)\s+\S+(?:\s+for\s+(session|agent))?$/.test(normalized);
}

function resolvePendingApproval(
  result: GatewayChatResult,
  streamedApproval: GatewayChatApprovalEvent | null,
): TuiApprovalDetails | null {
  if (streamedApproval) {
    return {
      approvalId: streamedApproval.approvalId,
      intent: streamedApproval.intent,
      reason: streamedApproval.reason,
      allowSession: streamedApproval.allowSession,
      allowAgent: streamedApproval.allowAgent,
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
    };
  }

  const prompt = String(result.result || '').trim();
  return prompt ? parseTuiApprovalPrompt(prompt) : null;
}

async function promptApprovalSelection(
  rl: readline.Interface,
  requestId: string,
  allowSession: boolean,
  allowAgent: boolean,
): Promise<string | null> {
  const options: Array<'once' | 'session' | 'agent' | 'skip'> = ['once'];
  if (allowSession) options.push('session');
  if (allowAgent) options.push('agent');
  options.push('skip');
  clearTuiSlashMenu();
  console.log(
    `  ${BOLD}${GOLD}Approval options${RESET} ${MUTED}(request ${requestId})${RESET}`,
  );
  options.forEach((option, index) => {
    const label =
      option === 'once'
        ? 'yes (once)'
        : option === 'session'
          ? 'yes for session'
          : option === 'agent'
            ? 'yes for agent'
            : 'no / skip';
    console.log(`  ${TEAL}${index + 1}${RESET} ${label}`);
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `  ${MUTED}Select 1-${options.length} (Enter to skip):${RESET} `,
      resolve,
    );
  });
  const command = mapApprovalSelectionToCommand(answer, requestId, options);
  if (answer.trim() && !command) {
    printInfo(
      `Unrecognized selection "${answer.trim()}". You can reply manually with yes/skip and the request id.`,
    );
  }
  return command;
}

function printBanner(
  modelInfo: {
    current: string;
    defaultModel: string;
  },
  sandboxMode: 'container' | 'host',
): void {
  clearTuiSlashMenu();
  const T = TEAL;
  const N = NAVY;
  const logo = [
    `${T}                            ####  ####${RESET}`,
    `${T}                       #########  #########${RESET}`,
    `${T}                    ####       #  #${N}      #####${RESET}`,
    `${T}                  ###          #  #${N}         ####${RESET}`,
    `${T}                ##             #  #${N}            ###${RESET}`,
    `${T}               ##       ##     #  #${N}    #        ###${RESET}`,
    `${T}  #######     ##       #####   #  #${N}   ####        ##${RESET}`,
    `${T}##### #####  ##         ###  ###  #${N}#    #          ##   ${N}######${RESET}`,
    `${T}## ##### ##  #                     ${N}##              ##   ##  ##${RESET}`,
    `${T} ###    ###  ##             #       ${N}#              ##    ####${RESET}`,
    `${T}       #      ##            ###    ${N}##            ####     ##${RESET}`,
    `${T}     ##           #           ##  ${N}##         ####  ##     ##${RESET}`,
    `${T} ####    ##        #               ${N}#  #       ####    ##      ##     ${N}###${RESET}`,
    `${T} ####    ####       ##             ${N}#  #    ###     ###        ##    ${N}####${RESET}`,
    `${T}            ####       ####   #    ${N}#  #  ###########         ##${RESET}`,
    `${T}######      ###    ##            ##${N}     #####        ####   ###        ${N}#####${RESET}`,
    `${T}          ##     ##           #    ${N}         ###       ###    ###${RESET}`,
    `${T}          ##     #              ###${N}######     ##        #    ##${RESET}`,
    `${T}          ##    #         #        ${N}   #######  ##       ##   ##${RESET}`,
    `${T}          ##    #           # ##   ${N}     ######  #       ##   ##${RESET}`,
    `${T}          ##    #          #####${N}######    ####  #       ##${RESET}`,
    `${T}                 #              ${N}       ###   ##  #       #    # #${RESET}`,
    `${T}       # ### #   #       #  ###${N}         ###    ##     ###   ######${RESET}`,
    `${T}       # ###      ##          #${N}#########     ##      ##     ######${RESET}`,
    `${T}                    #       #  ${N}            ###     ###${RESET}`,
    `${T}              ####   ###     ##${N}#####  ######     ###    ${N}####${RESET}`,
    `${T}                        ###   ${N}     # ##      #####${RESET}`,
    `${T}                           ###${N}### # ##########${RESET}`,
    `${T}                              ${N}  ##  ###${RESET}`,
  ];
  console.log();
  for (const line of logo) console.log(line);
  console.log();
  console.log(
    `  \u{1F99E} ${BOLD}${TEAL}H y b r i d ${GOLD}C l a w${RESET} ${MUTED}v${APP_VERSION}${RESET}`,
  );
  console.log(`${MUTED}     Powered by HybridAI${RESET}`);
  console.log();
  console.log(
    `  ${MUTED}Model:${RESET} ${TEAL}${modelInfo.current}${RESET}${MUTED} (default: ${modelInfo.defaultModel})${RESET}${MUTED} | Bot:${RESET} ${GOLD}${HYBRIDAI_CHATBOT_ID || 'unset'}${RESET}`,
  );
  console.log(
    `  ${MUTED}Gateway:${RESET} ${TEAL}${GATEWAY_BASE_URL}${RESET}${MUTED} | Sandbox:${RESET} ${GOLD}${sandboxMode}${RESET}`,
  );
  console.log(
    `  ${MUTED}HybridAI:${RESET} ${TEAL}${HYBRIDAI_BASE_URL}${RESET}`,
  );
  console.log();
}

function printHelp(): void {
  clearTuiSlashMenu();
  console.log();
  console.log(`  ${BOLD}${GOLD}Commands${RESET}`);
  console.log(
    `  ${TEAL}TAB${RESET} accept suggestion ${MUTED}|${RESET} ${TEAL}↑↓${RESET} navigate slash menu ${MUTED}|${RESET} ${TEAL}ESC${RESET} close menu`,
  );
  console.log(`  ${TEAL}/help${RESET}             Show this help`);
  console.log(
    `  ${TEAL}/agent [info|list|switch|create|model] [id] [--model <model>]${RESET} Inspect or manage agents`,
  );
  console.log(
    `  ${TEAL}/bot [info|list|set <id|name>]${RESET} Manage the chatbot for this session`,
  );
  console.log(
    `  ${TEAL}/model [<name>|info|list [provider]|set <name>|clear|default [name]]${RESET} Inspect or set session/default model`,
  );
  console.log(`  ${TEAL}/rag [on|off]${RESET}     Toggle or set RAG`);
  console.log(`  ${TEAL}/ralph [on|off|set n]${RESET} Configure Ralph loop`);
  console.log(`  ${TEAL}/status${RESET}           Show runtime status`);
  console.log(
    `  ${TEAL}/show [all|thinking|tools|none]${RESET} Control visible thinking/tool activity`,
  );
  console.log(
    `  ${TEAL}/approve [view|yes|session|agent|no] [approval_id]${RESET} View/respond to pending approvals`,
  );
  console.log(
    `  ${TEAL}/channel-mode <off|mention|free>${RESET} Set Discord channel mode`,
  );
  console.log(
    `  ${TEAL}/channel-policy <open|allowlist|disabled>${RESET} Set Discord guild policy`,
  );
  console.log(
    `  ${TEAL}/fullauto [status|off|on [prompt]|prompt]${RESET} Enable or inspect session full-auto mode`,
  );
  console.log(
    `  ${TEAL}/mcp [list|add|toggle|remove|reconnect] [name] [json]${RESET} Manage MCP servers`,
  );
  console.log(`  ${TEAL}/info${RESET}             Show current settings`);
  console.log(
    `  ${TEAL}/usage [summary|daily|monthly|model [daily|monthly] [agentId]]${RESET} Show usage`,
  );
  console.log(
    `  ${TEAL}/export [sessionId]${RESET} Export current or specified session JSONL`,
  );
  console.log(`  ${TEAL}/sessions${RESET}         List active sessions`);
  console.log(
    `  ${TEAL}/audit [sessionId]${RESET} Show recent structured audit events`,
  );
  console.log(
    `  ${TEAL}/skill list|inspect <name>|inspect --all|runs <name>|amend <name> [--apply|--reject|--rollback]|history <name>${RESET} Manage skill health, runs, and amendments`,
  );
  console.log(
    `  ${TEAL}/schedule add "<cron>" <prompt>${RESET} Add a scheduled task`,
  );
  console.log(
    `  ${TEAL}/compact${RESET}          Archive and compact older session history`,
  );
  console.log(`  ${TEAL}/clear${RESET}            Clear session history`);
  console.log(
    `  ${TEAL}/reset [yes|no]${RESET}    Clear history, reset session settings, and remove the agent workspace`,
  );
  console.log(
    `  ${TEAL}/stop${RESET}             Interrupt current request and disable full-auto`,
  );
  console.log(`  ${TEAL}/exit${RESET}             Quit`);
  console.log(`  ${TEAL}ESC${RESET}               Interrupt current request`);
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

function isModelCatalogCommandResult(result: GatewayCommandResult): boolean {
  const title = String(result.title || '').trim();
  return title.startsWith('Available Models') || title === 'Default Model';
}

function printModelCatalogCommandResult(result: GatewayCommandResult): void {
  clearTuiSlashMenu();
  console.log();
  if (result.title) {
    console.log(`  ${GOLD}${result.title}${RESET}`);
  }
  if (Array.isArray(result.modelCatalog) && result.modelCatalog.length > 0) {
    for (const entry of result.modelCatalog) {
      const color = entry.isFree ? GREEN : GOLD;
      console.log(`  ${color}${entry.label}${RESET}`);
    }
    console.log();
    return;
  }
  for (const line of result.text.split('\n')) {
    console.log(`  ${GOLD}${line}${RESET}`);
  }
  console.log();
}

function printToolUsage(tools: string[]): void {
  if (tools.length === 0) return;
  clearTuiSlashMenu();
  console.log(
    `  ${MUTED}${JELLYFISH} tools:${RESET} ${GREEN}${tools.join(', ')}${RESET}`,
  );
}

function terminalColumns(): number {
  return Math.max(24, process.stdout.columns || 120);
}

function formatTuiOutput(text: string): string {
  return wrapTuiBlock(text, terminalColumns(), '  ');
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
  printInfo(renderGatewayCommand(result));
}

function pickOceanActivityVerb(): string {
  const index = Math.floor(Math.random() * OCEAN_ACTIVITY_VERBS.length);
  return OCEAN_ACTIVITY_VERBS[index] || 'floating';
}

function spinner(): {
  stop: () => void;
  addTool: (toolName: string, preview?: string) => void;
  addVisibleTextDelta: (delta: string) => void;
  flushVisibleText: () => void;
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
  let transientToolLines = 0;
  let hasVisibleText = false;
  let visibleTextState = createTuiStreamFormatState();
  let thinkingPreviewRows = 0;
  const clearLine = () => process.stdout.write('\r\x1b[2K');
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
  const render = () => {
    if (stopped) return;
    if (!showActivityPreview) return;
    if (hasVisibleText || thinkingPreviewRows > 0) return;
    clearLine();
    const frame = JELLYFISH_PULSE_FRAMES[i % JELLYFISH_PULSE_FRAMES.length];
    process.stdout.write(
      `\r  ${frame.emojiColor}${JELLYFISH}${RESET} ${frame.verbColor}${activityVerb}${RESET}`,
    );
    i++;
  };

  const clearTools = () => {
    if (transientToolLines <= 0) return;
    process.stdout.write(`\x1b[${transientToolLines}A`);
    for (let i = 0; i < transientToolLines; i++) {
      clearLine();
      process.stdout.write('\x1b[M');
    }
    clearLine();
    transientToolLines = 0;
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

  const setThinkingPreview = (preview: string | null) => {
    if (!showThinkingPreview) return;
    const normalizedPreview = String(preview || '');
    if (!normalizedPreview) {
      clearThinkingPreview();
      return;
    }
    if (hasVisibleText) return;
    if (transientToolLines > 0) return;
    clearThinkingPreview();
    clearLine();
    const formatted = wrapTuiBlock(normalizedPreview, terminalColumns(), '  ');
    process.stdout.write(`\r${THINKING_PREVIEW_COLOR}${formatted}${RESET}`);
    thinkingPreviewRows = countTerminalRows(formatted, terminalColumns());
  };

  hideCursor();
  const interval = showActivityPreview ? setInterval(render, 350) : null;
  if (showActivityPreview) render();
  return {
    stop: () => {
      stopped = true;
      if (interval) clearInterval(interval);
      if (showActivityPreview && !hasVisibleText && thinkingPreviewRows === 0) {
        clearLine();
      }
      showCursor();
    },
    addTool: (toolName: string, preview?: string) => {
      if (!showTools) return;
      if (hasVisibleText) return;
      clearThinkingPreview();
      clearLine();
      const previewText = preview ? ` ${MUTED}${preview}${RESET}` : '';
      process.stdout.write(
        `  ${JELLYFISH} ${TEAL}${toolName}${RESET}${previewText}\n`,
      );
      transientToolLines++;
      if (showActivityPreview) render();
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
      process.stdout.write(formatted.text);
    },
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

function buildGatewayChatRequest(content: string): {
  sessionId: string;
  sessionMode: 'new' | 'resume';
  guildId: null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
} {
  return {
    ...sessionGatewayContext(),
    userId: TUI_USER_ID,
    username: TUI_USERNAME,
    content,
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
  const separator = `${MUTED}${'─'.repeat(terminalColumns() - 2)}${RESET}`;
  if (fullAutoLabel) {
    return `${separator}\n  ${GOLD}[${fullAutoLabel}]${RESET} ${TEAL}>${RESET} `;
  }
  return `${separator}\n  ${TEAL}>${RESET} `;
}

function clearTuiSlashMenu(): void {
  tuiSlashMenu?.clear();
}

function syncTuiSlashMenu(): void {
  tuiSlashMenu?.sync();
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
} | null> {
  try {
    const response = await gatewayHistory(tuiSessionId, 1, {
      summarySinceMs: tuiSessionStartedAtMs,
    });
    return response.summary || null;
  } catch {
    return null;
  }
}

async function finalizeTuiExit(): Promise<void> {
  if (tuiExitInProgress) return;
  tuiExitInProgress = true;
  clearTuiSlashMenu();
  tuiSlashMenu = null;

  const summary = await fetchTuiExitSummary();

  console.log();
  console.log();
  for (const line of buildTuiExitSummaryLines({
    sessionId: tuiSessionId,
    durationMs: Date.now() - tuiSessionStartedAtMs,
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
  })) {
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
): Promise<void> {
  try {
    const result = await requestGatewayCommand(args);
    printGatewayCommandResult(result);
    const normalizedCommand = (args[0] || '').trim().toLowerCase();
    const normalizedSubcommand = (args[1] || '').trim().toLowerCase();
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

function parseModelInfoFromInfo(
  result: GatewayCommandResult,
): { current: string; defaultModel: string } | null {
  const parsed = parseModelInfoSummaryFromText(result.text || '');
  if (!parsed) return null;
  return {
    current: parsed.current || parsed.defaultModel || HYBRIDAI_MODEL,
    defaultModel: parsed.defaultModel || parsed.current || HYBRIDAI_MODEL,
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
  Array<{ name: string; isFree: boolean }>
> {
  const fallback = normalizeModelCandidates(CONFIGURED_MODELS).map((model) => ({
    name: model,
    isFree: false,
  }));
  try {
    const result = await requestGatewayCommand(['model', 'list']);
    if (result.kind === 'error') return fallback;
    if (Array.isArray(result.modelCatalog) && result.modelCatalog.length > 0) {
      const seen = new Set<string>();
      const models: Array<{ name: string; isFree: boolean }> = [];
      for (const entry of result.modelCatalog) {
        const name = String(entry.value || '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        models.push({
          name,
          isFree: entry.isFree === true,
        });
      }
      return models.length > 0 ? models : fallback;
    }
    const models = parseModelNamesFromListText(result.text || '');
    return models.length > 0
      ? models.map((model) => ({ name: model, isFree: false }))
      : fallback;
  } catch {
    return fallback;
  }
}

async function fetchSessionAndDefaultModel(): Promise<{
  current: string;
  defaultModel: string;
}> {
  const fallback = { current: HYBRIDAI_MODEL, defaultModel: HYBRIDAI_MODEL };
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
    const currentColor =
      models.find((entry) => entry.name === currentModel)?.isFree === true
        ? GREEN
        : TEAL;
    console.log(
      `  ${MUTED}Current:${RESET} ${currentColor}${currentModel}${RESET}`,
    );
  }
  for (const [index, entry] of models.entries()) {
    const suffix =
      currentModel === entry.name ? ` ${MUTED}(current)${RESET}` : '';
    const modelColor = entry.isFree ? GREEN : RESET;
    console.log(
      `  ${TEAL}${index + 1}${RESET} ${modelColor}${entry.name}${RESET}${suffix}`,
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
    return models[asNumber - 1]?.name || null;
  }
  if (models.some((entry) => entry.name === trimmed)) return trimmed;

  printInfo('Invalid model selection.');
  return null;
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
        printInfo('Usage: /approve [view|yes|session|agent|no] [approval_id]');
        return true;
      }
      if (approvalResult.kind === 'missing-approval') {
        printInfo('No pending approval request is available to approve.');
        return true;
      }
      await processMessage(approvalResult.message, rl);
      return true;
    }
    case 'info':
      await runGatewayCommand(['bot', 'info'], rl);
      await runGatewayCommand(['model', 'info'], rl);
      await runGatewayCommand(['status'], rl);
      return true;
    case 'stop':
    case 'abort':
      if (
        activeRunAbortController &&
        !activeRunAbortController.signal.aborted
      ) {
        activeRunAbortController.abort();
        printInfo('Stopping current request and disabling full-auto...');
      } else {
        printInfo('No active foreground request. Disabling full-auto...');
      }
      await runGatewayCommand(['stop'], rl);
      return true;
    default:
      break;
  }

  const gatewayArgs = mapTuiSlashCommandToGatewayArgs(parts);
  if (!gatewayArgs) return false;
  await runGatewayCommand(gatewayArgs, rl);
  return true;
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

  try {
    const request = buildGatewayChatRequest(content);
    const streamState = createTuiThinkingStreamState();
    const streamedToolNames = new Set<string>();
    let sawStreamEvent = false;
    let sawVisibleTextDelta = false;
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
            const streamed = streamState.push(event.delta);
            if (streamed.visibleDelta) {
              sawVisibleTextDelta = true;
              s.addVisibleTextDelta(streamed.visibleDelta);
            } else if (streamed.thinkingPreview) {
              s.setThinkingPreview(streamed.thinkingPreview);
            }
            return;
          }
          if (event.type === 'approval') {
            sawStreamEvent = true;
            streamedApproval = event;
            return;
          }
          if (
            event.type !== 'tool' ||
            event.phase !== 'start' ||
            !event.toolName
          )
            return;
          sawStreamEvent = true;
          const preview = (event.preview || '').replace(/\s+/g, ' ').trim();
          const previewText =
            preview.length > TOOL_PREVIEW_MAX_CHARS
              ? `${preview.slice(0, TOOL_PREVIEW_MAX_CHARS - 1)}…`
              : preview;
          streamedToolNames.add(event.toolName);
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
    syncTuiSessionIdFromResult(result);

    const toolNames = [
      ...new Set([...streamedToolNames, ...collectToolNames(result)]),
    ];
    const hasStreamedText = sawVisibleTextDelta;
    const finalText = result.result || 'No response.';
    const pendingApproval = resolvePendingApproval(result, streamedApproval);

    s.flushVisibleText();
    s.stop();
    s.clearThinkingPreview();
    if (toolNames.length > 0) {
      if (!hasStreamedText) {
        s.clearTools();
      } else {
        process.stdout.write('\n');
      }
      printToolUsage(toolNames);
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
      const summary = formatTuiApprovalSummary(pendingApproval);
      tuiPendingApproval = {
        requestId: pendingApproval.approvalId,
        summary,
        intent: pendingApproval.intent,
        reason: pendingApproval.reason,
        allowSession: pendingApproval.allowSession,
        allowAgent: pendingApproval.allowAgent,
      };
      printResponse(summary);
      const approvalCommand = await promptApprovalSelection(
        rl,
        pendingApproval.approvalId,
        pendingApproval.allowSession,
        pendingApproval.allowAgent,
      );
      if (approvalCommand) {
        await processMessage(approvalCommand, rl);
      }
    } else {
      if (isApprovalResponseContent(content)) {
        tuiPendingApproval = null;
      }
      if (hasStreamedText) {
        console.log();
      } else {
        printResponse(finalText, {
          leadingBlank: toolNames.length > 0,
        });
      }
    }
  } catch (err) {
    s.flushVisibleText();
    s.stop();
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
  tuiFullAutoState = {
    ...tuiFullAutoState,
    runtimeState: 'steering',
  };
  refreshPrompt(rl);
  printInfo('Sent guidance to full-auto. Reply will arrive asynchronously.');

  void (async () => {
    try {
      const result = await gatewayChat(
        buildGatewayChatRequest(content),
        abortController.signal,
      );
      syncTuiSessionIdFromResult(result);
      if (isInterruptedResult(result)) {
        return;
      }
      if (result.status === 'error') {
        printError(result.error || 'Unknown error');
        return;
      }
      const pendingApproval = resolvePendingApproval(result, null);
      if (pendingApproval) {
        const summary = formatTuiApprovalSummary(pendingApproval);
        tuiPendingApproval = {
          requestId: pendingApproval.approvalId,
          summary,
          intent: pendingApproval.intent,
          reason: pendingApproval.reason,
          allowSession: pendingApproval.allowSession,
          allowAgent: pendingApproval.allowAgent,
        };
        printResponse(summary);
        const approvalCommand = await promptApprovalSelection(
          rl,
          pendingApproval.approvalId,
          pendingApproval.allowSession,
          pendingApproval.allowAgent,
        );
        if (approvalCommand) {
          await processMessage(approvalCommand, rl);
        }
        return;
      }
      printResponse(result.result || 'No response.');
    } catch (err) {
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

async function pollProactiveMessages(rl: readline.Interface): Promise<void> {
  if (proactivePollInFlight) return;
  if (activeRunAbortController && !activeRunAbortController.signal.aborted)
    return;

  proactivePollInFlight = true;
  try {
    const result = await gatewayPullProactive(CHANNEL_ID, 20);
    if (!Array.isArray(result.messages) || result.messages.length === 0) return;

    clearTuiSlashMenu();
    console.log();
    for (const message of result.messages) {
      const suffix = proactiveSourceSuffix(message.source);
      const sourceSuffix = suffix ? ` ${MUTED}${suffix}${RESET}` : '';
      console.log(
        `  ${GOLD}[${proactiveBadgeLabel(message.source)}]${RESET} ${message.text}${sourceSuffix}`,
      );
    }
    console.log();
    promptTuiInput(rl);
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
  printBanner(modelInfo, status.sandbox?.mode || 'container');

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
  tuiSlashMenu = new TuiSlashMenuController({
    rl,
    entries: buildTuiSlashMenuEntries(),
    palette: slashMenuPalette,
    shouldShow: () =>
      !activeRunAbortController || activeRunAbortController.signal.aborted,
  });
  tuiSlashMenu.install();
  refreshPrompt(rl);

  readline.emitKeypressEvents(process.stdin, rl);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_str, key) => {
    if (key?.name !== 'escape') return;
    if (!activeRunAbortController || activeRunAbortController.signal.aborted)
      return;
    activeRunAbortController.abort();
  });

  promptTuiInput(rl);
  let pendingInputLines: string[] = [];
  let pendingInputTimer: ReturnType<typeof setTimeout> | null = null;
  let inputRunQueue = Promise.resolve();

  const enqueueInput = (input: string): void => {
    inputRunQueue = inputRunQueue
      .then(async () => {
        const trimmed = input.trim();
        clearTuiSlashMenu();
        if (!trimmed) {
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
    const combined = pendingInputLines.join('\n');
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
  tuiResumeCommand =
    String(options?.resumeCommand || 'hybridclaw tui --resume').trim() ||
    'hybridclaw tui --resume';
  activeRunAbortController = null;
  proactivePollInFlight = false;
  tuiFullAutoState = DEFAULT_TUI_FULLAUTO_STATE;
  fullAutoSteeringInFlight = false;
  tuiPendingApproval = null;
  tuiShowMode = DEFAULT_SESSION_SHOW_MODE;
  tuiSlashMenu = null;
  tuiExitInProgress = false;
  await main();
}
