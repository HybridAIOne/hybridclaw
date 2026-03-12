/**
 * HybridClaw TUI — thin client for the gateway API.
 * Usage: npm run tui
 */
import readline from 'node:readline';

import {
  APP_VERSION,
  CONFIGURED_MODELS,
  GATEWAY_BASE_URL,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_MODEL,
} from './config/config.js';
import {
  type GatewayChatResult,
  type GatewayCommandResult,
  gatewayChat,
  gatewayChatStream,
  gatewayCommand,
  gatewayPullProactive,
  gatewayStatus,
  renderGatewayCommand,
} from './gateway/gateway-client.js';
import { logger } from './logger.js';
import {
  normalizeModelCandidates,
  parseModelNamesFromListText,
} from './model-selection.js';
import {
  DEFAULT_TUI_FULLAUTO_STATE,
  deriveTuiFullAutoState,
  formatTuiFullAutoPromptLabel,
  parseFullAutoStatusText,
  shouldRouteTuiInputToFullAuto,
  type TuiFullAutoState,
} from './tui-fullauto.js';
import { proactiveBadgeLabel, proactiveSourceSuffix } from './tui-proactive.js';
import {
  mapTuiSlashCommandToGatewayArgs,
  parseTuiSlashCommand,
} from './tui-slash-command.js';
import { appendThinkingPreview } from './tui-thinking.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const JELLYFISH = '🪼';

type TuiTheme = 'dark' | 'light';

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

const PALETTE = resolveTuiTheme() === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
const MUTED = PALETTE.muted;
const TEAL = PALETTE.teal;
const NAVY = PALETTE.navy;
const GOLD = PALETTE.gold;
const GREEN = PALETTE.green;
const RED = PALETTE.red;

const SESSION_ID = 'tui:local';
const CHANNEL_ID = 'tui';
const TUI_USER_ID = 'tui-user';
const TUI_USERNAME = 'user';
const TUI_MULTILINE_PASTE_DEBOUNCE_MS = Math.max(
  20,
  parseInt(process.env.TUI_MULTILINE_PASTE_DEBOUNCE_MS || '90', 10) || 90,
);
const TUI_PROACTIVE_POLL_INTERVAL_MS = Math.max(
  500,
  parseInt(process.env.TUI_PROACTIVE_POLL_INTERVAL_MS || '2500', 10) || 2500,
);
const TOOL_PREVIEW_MAX_CHARS = 140;
const THINKING_PREVIEW_MIN_CHARS = 48;

let activeRunAbortController: AbortController | null = null;
let proactivePollInFlight = false;
let tuiFullAutoState: TuiFullAutoState = DEFAULT_TUI_FULLAUTO_STATE;
let fullAutoSteeringInFlight = false;
let tuiPendingApproval: { requestId: string; prompt: string } | null = null;

function findPendingApprovalRequestId(
  result: GatewayChatResult,
): string | null {
  const executions = result.toolExecutions || [];
  for (let i = executions.length - 1; i >= 0; i -= 1) {
    const execution = executions[i];
    if (execution.approvalDecision !== 'required') continue;
    if (!execution.approvalRequestId) continue;
    return execution.approvalRequestId;
  }
  return null;
}

function mapApprovalSelectionToCommand(
  selection: string,
  requestId: string,
): string | null {
  const normalized = selection.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return null;

  if (
    normalized === '1' ||
    normalized === 'yes' ||
    normalized === 'y' ||
    normalized === 'once'
  ) {
    return `yes ${requestId}`;
  }
  if (
    normalized === '2' ||
    normalized === 'session' ||
    normalized === 'yes for session' ||
    normalized === 'for session'
  ) {
    return `yes ${requestId} for session`;
  }
  if (
    normalized === '3' ||
    normalized === 'agent' ||
    normalized === 'yes for agent' ||
    normalized === 'for agent'
  ) {
    return `yes ${requestId} for agent`;
  }
  if (
    normalized === '4' ||
    normalized === 'no' ||
    normalized === 'n' ||
    normalized === 'skip'
  ) {
    return `skip ${requestId}`;
  }
  return null;
}

function isApprovalResponseContent(content: string): boolean {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  return /^(yes|skip)\s+\S+(?:\s+for\s+(session|agent))?$/.test(normalized);
}

function mapTuiApproveSlashToMessage(parts: string[]): string | null {
  const action = (parts[1] || 'view').trim().toLowerCase();
  const approvalId = (parts[2] || tuiPendingApproval?.requestId || '').trim();
  if (action === 'view' || action === 'status' || action === 'show') {
    return null;
  }
  if (!approvalId) return '';
  if (action === 'yes') return `yes ${approvalId}`;
  if (action === 'session') return `yes ${approvalId} for session`;
  if (action === 'agent') return `yes ${approvalId} for agent`;
  if (action === 'no') return `skip ${approvalId}`;
  return '';
}

async function promptApprovalSelection(
  rl: readline.Interface,
  requestId: string,
): Promise<string | null> {
  console.log(
    `  ${BOLD}${GOLD}Approval options${RESET} ${MUTED}(request ${requestId})${RESET}`,
  );
  console.log(`  ${TEAL}1${RESET} yes (once)`);
  console.log(`  ${TEAL}2${RESET} yes for session`);
  console.log(`  ${TEAL}3${RESET} yes for agent`);
  console.log(`  ${TEAL}4${RESET} no / skip`);
  const answer = await new Promise<string>((resolve) => {
    rl.question(`  ${MUTED}Select 1-4 (Enter to skip):${RESET} `, resolve);
  });
  const command = mapApprovalSelectionToCommand(answer, requestId);
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
  console.log();
  console.log(`  ${BOLD}${GOLD}Commands${RESET}`);
  console.log(`  ${TEAL}/help${RESET}             Show this help`);
  console.log(`  ${TEAL}/agent${RESET}            Show current session agent`);
  console.log(`  ${TEAL}/agent list${RESET}       List available agents`);
  console.log(`  ${TEAL}/agent switch <id>${RESET} Switch this session to an agent`);
  console.log(
    `  ${TEAL}/agent create <id> [--model <model>]${RESET} Create a new agent`,
  );
  console.log(`  ${TEAL}/bots${RESET}             List available bots`);
  console.log(`  ${TEAL}/bot <id|name>${RESET}    Switch bot for this session`);
  console.log(`  ${TEAL}/model${RESET}            Pick model from selector`);
  console.log(`  ${TEAL}/model <name>${RESET}     Set model for this session`);
  console.log(
    `  ${TEAL}/model default [name]${RESET} Show or set default model`,
  );
  console.log(`  ${TEAL}/rag [on|off]${RESET}     Toggle or set RAG`);
  console.log(`  ${TEAL}/ralph [on|off|set n]${RESET} Configure Ralph loop`);
  console.log(`  ${TEAL}/status${RESET}           Show runtime status`);
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
  console.log(`  ${TEAL}/mcp list${RESET}         List configured MCP servers`);
  console.log(
    `  ${TEAL}/mcp add <name> <json>${RESET} Add or update an MCP server`,
  );
  console.log(
    `  ${TEAL}/mcp toggle <name>${RESET} Disable or enable an MCP server`,
  );
  console.log(
    `  ${TEAL}/mcp remove <name>${RESET} Remove an MCP server config`,
  );
  console.log(
    `  ${TEAL}/mcp reconnect <name>${RESET} Restart MCP for the current session`,
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

function printResponse(text: string): void {
  console.log();
  for (const line of text.split('\n')) {
    console.log(`  ${line}`);
  }
  console.log();
}

function printError(text: string): void {
  console.log(`\n  ${RED}Error: ${text}${RESET}\n`);
}

function printInfo(text: string): void {
  console.log();
  for (const line of text.split('\n')) {
    console.log(`  ${GOLD}${line}${RESET}`);
  }
  console.log();
}

function printToolUsage(tools: string[]): void {
  if (tools.length === 0) return;
  console.log(
    `  ${MUTED}${JELLYFISH} tools:${RESET} ${GREEN}${tools.join(', ')}${RESET}`,
  );
}

function printGatewayCommandResult(result: GatewayCommandResult): void {
  if (result.kind === 'error') {
    const prefix = result.title ? `${result.title}: ` : '';
    printError(`${prefix}${result.text}`);
    return;
  }
  printInfo(renderGatewayCommand(result));
}

function spinner(): {
  stop: () => void;
  addTool: (toolName: string, preview?: string) => void;
  addTextDelta: (delta: string) => void;
  clearTools: () => void;
} {
  const dots = ['   ', '.  ', '.. ', '...'];
  let i = 0;
  let transientToolLines = 0;
  let thinkingPreview = '';
  const clearLine = () => process.stdout.write('\r\x1b[2K');
  const previewMaxChars = () =>
    Math.max(THINKING_PREVIEW_MIN_CHARS, (process.stdout.columns || 120) - 18);
  const render = () => {
    clearLine();
    const prefix = `${TEAL}thinking${dots[i % dots.length]}${RESET}`;
    if (!thinkingPreview) {
      process.stdout.write(`\r${prefix}`);
    } else {
      process.stdout.write(`\r${prefix} ${MUTED}${thinkingPreview}${RESET}`);
    }
    i++;
  };
  const interval = setInterval(render, 350);
  render();
  return {
    stop: () => {
      clearInterval(interval);
      clearLine();
    },
    addTool: (toolName: string, preview?: string) => {
      clearLine();
      const previewText = preview ? ` ${MUTED}${preview}${RESET}` : '';
      process.stdout.write(
        `  ${JELLYFISH} ${TEAL}${toolName}${RESET}${previewText}\n`,
      );
      transientToolLines++;
      render();
    },
    addTextDelta: (delta: string) => {
      thinkingPreview = appendThinkingPreview(
        thinkingPreview,
        delta,
        previewMaxChars(),
      );
      render();
    },
    clearTools: () => {
      if (transientToolLines <= 0) return;
      process.stdout.write(`\x1b[${transientToolLines}A`);
      for (let i = 0; i < transientToolLines; i++) {
        clearLine();
        process.stdout.write('\x1b[M');
      }
      clearLine();
      transientToolLines = 0;
    },
  };
}

function sessionGatewayContext(): {
  sessionId: string;
  guildId: null;
  channelId: string;
} {
  return {
    sessionId: SESSION_ID,
    guildId: null,
    channelId: CHANNEL_ID,
  };
}

function buildGatewayChatRequest(content: string): {
  sessionId: string;
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
  return gatewayCommand({
    ...sessionGatewayContext(),
    args,
    userId: TUI_USER_ID,
    username: TUI_USERNAME,
  });
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

function buildPromptText(): string {
  const fullAutoLabel = formatTuiFullAutoPromptLabel(tuiFullAutoState);
  if (fullAutoLabel) {
    return `${GOLD}[${fullAutoLabel}]${RESET} ${TEAL}>${RESET} `;
  }
  return `${TEAL}>${RESET} `;
}

function refreshPrompt(rl: readline.Interface): void {
  rl.setPrompt(buildPromptText());
}

async function fetchInitialFullAutoState(): Promise<TuiFullAutoState> {
  try {
    const result = await requestGatewayCommand(['fullauto', 'status']);
    return parseFullAutoStatusText(result.text) || DEFAULT_TUI_FULLAUTO_STATE;
  } catch {
    return DEFAULT_TUI_FULLAUTO_STATE;
  }
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
  const text = (result.text || '').trim();
  if (!text) return null;
  const currentMatch = text.match(/Current model:\s*([^\n\r]+)/i);
  const defaultMatch = text.match(/Default model:\s*([^\n\r]+)/i);
  const current = (currentMatch?.[1] || '').trim();
  const defaultModel = (defaultMatch?.[1] || '').trim();
  if (!current && !defaultModel) return null;
  return {
    current: current || defaultModel || HYBRIDAI_MODEL,
    defaultModel: defaultModel || current || HYBRIDAI_MODEL,
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

async function fetchSelectableModels(): Promise<string[]> {
  const fallback = normalizeModelCandidates(CONFIGURED_MODELS);
  try {
    const result = await requestGatewayCommand(['model', 'list']);
    if (result.kind === 'error') return fallback;
    const models = parseModelNamesFromListText(result.text || '');
    return models.length > 0 ? models : fallback;
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
  const models = await fetchSelectableModels();
  if (models.length === 0) {
    printError('No models configured.');
    return null;
  }

  const currentModel = await fetchCurrentSessionModel();
  console.log(`  ${BOLD}${GOLD}Model selector${RESET}`);
  if (currentModel) {
    console.log(`  ${MUTED}Current:${RESET} ${TEAL}${currentModel}${RESET}`);
  }
  for (const [index, model] of models.entries()) {
    const suffix = currentModel === model ? ` ${MUTED}(current)${RESET}` : '';
    console.log(`  ${TEAL}${index + 1}${RESET} ${model}${suffix}`);
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
    return models[asNumber - 1];
  }
  if (models.includes(trimmed)) return trimmed;

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
      console.log(`\n  ${GOLD}Goodbye!${RESET}\n`);
      rl.close();
      process.exit(0);
      return true;
    case 'model':
      if (parts.length === 1 || parts[1] === 'select') {
        const selectedModel = await promptModelSelection(rl);
        if (selectedModel) {
          await runGatewayCommand(['model', 'set', selectedModel], rl);
        }
        return true;
      }
      if (parts[1] === 'default') {
        if (parts.length > 2) {
          await runGatewayCommand(['model', 'default', ...parts.slice(2)], rl);
        } else {
          await runGatewayCommand(['model', 'default'], rl);
        }
        return true;
      }
      if (parts[1] === 'info' || parts[1] === 'list') {
        await runGatewayCommand(['model', parts[1]], rl);
        return true;
      }
      await runGatewayCommand(['model', 'set', ...parts.slice(1)], rl);
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
        printInfo(tuiPendingApproval.prompt);
        return true;
      }

      const approvalMessage = mapTuiApproveSlashToMessage(parts);
      if (approvalMessage === '') {
        printInfo(
          'Usage: /approve [view|yes|session|agent|no] [approval_id]',
        );
        return true;
      }
      if (!approvalMessage) {
        printInfo('No pending approval request is available to approve.');
        return true;
      }
      await processMessage(approvalMessage, rl);
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

  const s = spinner();
  const abortController = new AbortController();
  activeRunAbortController = abortController;

  try {
    const request = buildGatewayChatRequest(content);
    const streamedToolNames = new Set<string>();
    let result: GatewayChatResult;

    try {
      result = await gatewayChatStream(
        {
          ...request,
          stream: true,
        },
        (event) => {
          if (event.type === 'text') {
            s.addTextDelta(event.delta);
            return;
          }
          if (
            event.type !== 'tool' ||
            event.phase !== 'start' ||
            !event.toolName
          )
            return;
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
      result = await gatewayChat(request, abortController.signal);
    }

    const toolNames = [
      ...new Set([...streamedToolNames, ...collectToolNames(result)]),
    ];

    s.stop();
    if (toolNames.length > 0) {
      s.clearTools();
      printToolUsage(toolNames);
    }

    if (isInterruptedResult(result)) {
      return;
    }

    if (result.status === 'error') {
      printError(result.error || 'Unknown error');
      return;
    }

    printResponse(result.result || 'No response.');
    const pendingApprovalId = findPendingApprovalRequestId(result);
    if (pendingApprovalId) {
      tuiPendingApproval = {
        requestId: pendingApprovalId,
        prompt: result.result || `Approval required (${pendingApprovalId}).`,
      };
      const approvalCommand = await promptApprovalSelection(
        rl,
        pendingApprovalId,
      );
      if (approvalCommand) {
        await processMessage(approvalCommand, rl);
      }
    } else if (isApprovalResponseContent(content)) {
      tuiPendingApproval = null;
    }
  } catch (err) {
    s.stop();
    if (abortController.signal.aborted) return;
    printError(err instanceof Error ? err.message : String(err));
  } finally {
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
      if (isInterruptedResult(result)) {
        return;
      }
      if (result.status === 'error') {
        printError(result.error || 'Unknown error');
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
      rl.prompt();
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

    console.log();
    for (const message of result.messages) {
      const suffix = proactiveSourceSuffix(message.source);
      const sourceSuffix = suffix ? ` ${MUTED}${suffix}${RESET}` : '';
      console.log(
        `  ${GOLD}[${proactiveBadgeLabel(message.source)}]${RESET} ${message.text}${sourceSuffix}`,
      );
    }
    console.log();
    rl.prompt();
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
  printBanner(modelInfo, status.sandbox?.mode || 'container');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPromptText(),
    historySize: 100,
  });
  refreshPrompt(rl);

  readline.emitKeypressEvents(process.stdin, rl);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_str, key) => {
    if (key?.name !== 'escape') return;
    if (!activeRunAbortController || activeRunAbortController.signal.aborted)
      return;
    activeRunAbortController.abort();
  });

  rl.prompt();
  let pendingInputLines: string[] = [];
  let pendingInputTimer: ReturnType<typeof setTimeout> | null = null;
  let inputRunQueue = Promise.resolve();

  const enqueueInput = (input: string): void => {
    inputRunQueue = inputRunQueue
      .then(async () => {
        const trimmed = input.trim();
        if (!trimmed) {
          rl.prompt();
          return;
        }
        if (!input.includes('\n') && trimmed.startsWith('/')) {
          const handled = await handleSlashCommand(trimmed, rl);
          if (handled) {
            rl.prompt();
            return;
          }
        }
        if (shouldRouteTuiInputToFullAuto(tuiFullAutoState)) {
          const liveFullAutoState = await syncFullAutoStateFromGateway(rl);
          if (shouldRouteTuiInputToFullAuto(liveFullAutoState)) {
            await processFullAutoSteeringMessage(input, rl);
            rl.prompt();
            return;
          }
        }
        if (shouldRouteTuiInputToFullAuto(tuiFullAutoState)) {
          await processFullAutoSteeringMessage(input, rl);
          rl.prompt();
          return;
        }
        await processMessage(input, rl);
        rl.prompt();
      })
      .catch((err) => {
        printError(err instanceof Error ? err.message : String(err));
        rl.prompt();
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
    console.log(`\n${MUTED}  Goodbye!${RESET}\n`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('TUI error:', err);
  process.exit(1);
});
