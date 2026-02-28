/**
 * HybridClaw TUI — thin client for the gateway API.
 * Usage: npm run tui
 */
import readline from 'readline';

import { APP_VERSION, GATEWAY_BASE_URL, HYBRIDAI_BASE_URL, HYBRIDAI_CHATBOT_ID, HYBRIDAI_MODEL } from './config.js';
import {
  gatewayChat,
  gatewayCommand,
  gatewayStatus,
  renderGatewayCommand,
  type GatewayCommandResult,
} from './gateway-client.js';
import { logger } from './logger.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const TEAL = '\x1b[38;2;92;224;216m';
const NAVY = '\x1b[38;2;30;58;95m';
const GOLD = '\x1b[38;2;255;215;0m';
const GREEN = '\x1b[38;2;16;185;129m';
const RED = '\x1b[38;2;239;68;68m';

const SESSION_ID = 'tui:local';
const CHANNEL_ID = 'tui';
const TUI_MULTILINE_PASTE_DEBOUNCE_MS = Math.max(
  20,
  parseInt(process.env.TUI_MULTILINE_PASTE_DEBOUNCE_MS || '90', 10) || 90,
);

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
  console.log(`  \u{1F99E} ${BOLD}${TEAL}H y b r i d ${GOLD}C l a w${RESET} ${DIM}v${APP_VERSION}${RESET}`);
  console.log(`${DIM}     Powered by HybridAI${RESET}`);
  console.log();
  console.log(`  ${DIM}Model: ${TEAL}${HYBRIDAI_MODEL}${RESET}${DIM} | Bot: ${GOLD}${HYBRIDAI_CHATBOT_ID || 'unset'}${RESET}`);
  console.log(`  ${DIM}Gateway: ${TEAL}${GATEWAY_BASE_URL}${RESET}`);
  console.log(`  ${DIM}HybridAI: ${TEAL}${HYBRIDAI_BASE_URL}${RESET}`);
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
  console.log(`\n${RED}  Error: ${text}${RESET}\n`);
}

function printInfo(text: string): void {
  console.log(`\n${GOLD}  ${text}${RESET}\n`);
}

function printToolUsage(tools: string[]): void {
  if (tools.length === 0) return;
  console.log(`${DIM}  tools: ${GREEN}${tools.join(', ')}${RESET}`);
}

function printGatewayCommandResult(result: GatewayCommandResult): void {
  if (result.kind === 'error') {
    const prefix = result.title ? `${result.title}: ` : '';
    printError(`${prefix}${result.text}`);
    return;
  }
  printInfo(renderGatewayCommand(result));
}

function spinner(): { stop: () => void } {
  const dots = ['   ', '.  ', '.. ', '...'];
  let i = 0;
  const clearLine = () => process.stdout.write('\r\x1b[2K');
  const render = () => {
    clearLine();
    process.stdout.write(`\r  ${TEAL}thinking${dots[i % dots.length]}${RESET}`);
    i++;
  };
  const interval = setInterval(render, 350);
  render();
  return {
    stop: () => {
      clearInterval(interval);
      clearLine();
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
    const result = await gatewayChat(
      {
        sessionId: SESSION_ID,
        guildId: null,
        channelId: CHANNEL_ID,
        userId: 'tui-user',
        username: 'user',
        content,
      },
      abortController.signal,
    );
    s.stop();

    if (result.status === 'error') {
      if ((result.error || '').includes('aborted') || (result.error || '').includes('Interrupted')) return;
      printError(result.error || 'Unknown error');
      return;
    }

    printToolUsage(result.toolsUsed);
    printResponse(result.result || 'No response.');
  } catch (err) {
    s.stop();
    if (abortController.signal.aborted) return;
    printError(err instanceof Error ? err.message : String(err));
  } finally {
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
    console.log(`\n${DIM}  Goodbye!${RESET}\n`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('TUI error:', err);
  process.exit(1);
});
