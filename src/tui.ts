/**
 * HybridClaw TUI — thin client for the gateway API.
 * Usage: npm run tui
 */
import readline from 'readline';

import { APP_VERSION, GATEWAY_BASE_URL, HYBRIDAI_BASE_URL, HYBRIDAI_CHATBOT_ID, HYBRIDAI_MODEL } from './config.js';
import {
  gatewayChatStream,
  gatewayCommand,
  gatewayChat,
  gatewayStatus,
  renderGatewayCommand,
  type GatewayChatResult,
  type GatewayCommandResult,
} from './gateway-client.js';
import { logger } from './logger.js';

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

  const parts = raw.split(/[;:]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const bg = Number.parseInt(parts[parts.length - 1], 10);
  if (Number.isNaN(bg)) return null;

  if (bg === 7 || bg === 11 || bg === 14 || bg === 15) return 'light';
  return 'dark';
}

function resolveTuiTheme(): TuiTheme {
  const override = (process.env.HYBRIDCLAW_THEME || process.env.HYBRIDCLAW_TUI_THEME || process.env.TUI_THEME || '').trim().toLowerCase();
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
const TUI_MULTILINE_PASTE_DEBOUNCE_MS = Math.max(
  20,
  parseInt(process.env.TUI_MULTILINE_PASTE_DEBOUNCE_MS || '90', 10) || 90,
);
const TOOL_PREVIEW_MAX_CHARS = 140;

let activeRunAbortController: AbortController | null = null;

function printBanner(): void {
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
  console.log(`  \u{1F99E} ${BOLD}${TEAL}H y b r i d ${GOLD}C l a w${RESET} ${MUTED}v${APP_VERSION}${RESET}`);
  console.log(`${MUTED}     Powered by HybridAI${RESET}`);
  console.log();
  console.log(`  ${MUTED}Model:${RESET} ${TEAL}${HYBRIDAI_MODEL}${RESET}${MUTED} | Bot:${RESET} ${GOLD}${HYBRIDAI_CHATBOT_ID || 'unset'}${RESET}`);
  console.log(`  ${MUTED}Gateway:${RESET} ${TEAL}${GATEWAY_BASE_URL}${RESET}`);
  console.log(`  ${MUTED}HybridAI:${RESET} ${TEAL}${HYBRIDAI_BASE_URL}${RESET}`);
  console.log();
}

function printHelp(): void {
  console.log();
  console.log(`  ${BOLD}${GOLD}Commands${RESET}`);
  console.log(`  ${TEAL}/help${RESET}             Show this help`);
  console.log(`  ${TEAL}/bots${RESET}             List available bots`);
  console.log(`  ${TEAL}/bot <id|name>${RESET}    Switch bot for this session`);
  console.log(`  ${TEAL}/rag [on|off]${RESET}     Toggle or set RAG`);
  console.log(`  ${TEAL}/info${RESET}             Show current settings`);
  console.log(`  ${TEAL}/clear${RESET}            Clear session history`);
  console.log(`  ${TEAL}/stop${RESET}             Interrupt current request`);
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
  console.log(`\n  ${GOLD}${text}${RESET}\n`);
}

function printToolUsage(tools: string[]): void {
  if (tools.length === 0) return;
  console.log(`  ${MUTED}${JELLYFISH} tools:${RESET} ${GREEN}${tools.join(', ')}${RESET}`);
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
  clearTools: () => void;
} {
  const dots = ['   ', '.  ', '.. ', '...'];
  let i = 0;
  let transientToolLines = 0;
  const clearLine = () => process.stdout.write('\r\x1b[2K');
  const render = () => {
    clearLine();
      process.stdout.write(`\r${TEAL}thinking${dots[i % dots.length]}${RESET}`);
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
      process.stdout.write(`  ${JELLYFISH} ${TEAL}${toolName}${RESET}${previewText}\n`);
      transientToolLines++;
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

async function runGatewayCommand(args: string[]): Promise<void> {
  try {
    const result = await gatewayCommand({
      sessionId: SESSION_ID,
      guildId: null,
      channelId: CHANNEL_ID,
      args,
    });
    printGatewayCommandResult(result);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}

async function handleSlashCommand(input: string, rl: readline.Interface): Promise<boolean> {
  const parts = input.slice(1).trim().split(/\s+/).filter(Boolean);
  const cmd = (parts[0] || '').toLowerCase();

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
    case 'bots':
      await runGatewayCommand(['bot', 'list']);
      return true;
    case 'bot':
      if (parts.length > 1) {
        await runGatewayCommand(['bot', 'set', ...parts.slice(1)]);
      } else {
        await runGatewayCommand(['bot', 'info']);
      }
      return true;
    case 'rag':
      if (parts.length > 1 && (parts[1] === 'on' || parts[1] === 'off')) {
        await runGatewayCommand(['rag', parts[1]]);
      } else {
        await runGatewayCommand(['rag']);
      }
      return true;
    case 'info':
      await runGatewayCommand(['bot', 'info']);
      await runGatewayCommand(['model', 'info']);
      await runGatewayCommand(['status']);
      return true;
    case 'clear':
      await runGatewayCommand(['clear']);
      return true;
    case 'stop':
    case 'abort':
      if (activeRunAbortController && !activeRunAbortController.signal.aborted) {
        activeRunAbortController.abort();
        printInfo('Stopping current request...');
      } else {
        printInfo('No active request.');
      }
      return true;
    default:
      return false;
  }
}

async function processMessage(content: string): Promise<void> {
  const s = spinner();
  const abortController = new AbortController();
  activeRunAbortController = abortController;

  try {
    const request: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
    } = {
      sessionId: SESSION_ID,
      guildId: null,
      channelId: CHANNEL_ID,
      userId: 'tui-user',
      username: 'user',
      content,
    };
    const toolNames = new Set<string>();
    let result: GatewayChatResult;

    try {
      result = await gatewayChatStream(
        {
          ...request,
          stream: true,
        },
        (event) => {
          if (event.type !== 'tool' || event.phase !== 'start' || !event.toolName) return;
          const preview = (event.preview || '').replace(/\s+/g, ' ').trim();
          const previewText = preview.length > TOOL_PREVIEW_MAX_CHARS
            ? `${preview.slice(0, TOOL_PREVIEW_MAX_CHARS - 1)}…`
            : preview;
          toolNames.add(event.toolName);
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

    for (const execution of result.toolExecutions || []) {
      if (execution.name) {
        toolNames.add(execution.name);
      }
    }
    if (toolNames.size === 0) {
      for (const toolName of result.toolsUsed || []) {
        if (toolName) {
          toolNames.add(toolName);
        }
      }
    }

    s.stop();
    if (toolNames.size > 0) {
      s.clearTools();
      printToolUsage(Array.from(toolNames));
    }

    if ((result.error || '').includes('aborted') || (result.error || '').includes('Interrupted')) {
      return;
    }

    if (result.status === 'error') {
      printError(result.error || 'Unknown error');
      return;
    }

    printResponse(result.result || 'No response.');
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

async function main(): Promise<void> {
  logger.level = 'warn';
  await gatewayStatus();
  printBanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${TEAL}>${RESET} `,
    historySize: 100,
  });

  readline.emitKeypressEvents(process.stdin, rl);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_str, key) => {
    if (key?.name !== 'escape') return;
    if (!activeRunAbortController || activeRunAbortController.signal.aborted) return;
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
        await processMessage(input);
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
    pendingInputTimer = setTimeout(flushPendingInput, TUI_MULTILINE_PASTE_DEBOUNCE_MS);
  });

  rl.on('close', () => {
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
