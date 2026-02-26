/**
 * HybridClaw TUI — Terminal UI to talk to the bot directly.
 * Bypasses Discord, calls containers directly with IPC.
 * Usage: npm run tui
 */
import readline from 'readline';

import {
  HEARTBEAT_INTERVAL,
  HYBRIDAI_API_KEY,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_ENABLE_RAG,
  HYBRIDAI_MODEL,
} from './config.js';
import { runAgent } from './agent.js';
import {
  clearSessionHistory,
  getConversationHistory,
  getOrCreateSession,
  getTasksForSession,
  initDatabase,
  storeMessage,
} from './db.js';
import { processSideEffects } from './side-effects.js';
import { logger } from './logger.js';
import type { ChatMessage, HybridAIBot, ToolProgressEvent } from './types.js';
import { buildSkillsPrompt, expandSkillInvocation, loadSkills } from './skills.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import {
  buildContextPrompt,
  ensureBootstrapFiles,
  isBootstrapping,
  loadBootstrapFiles,
} from './workspace.js';

// --- Colors (HybridAI brand: teal + navy from yin-yang logo) ---
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const TEAL = '\x1b[38;2;92;224;216m';    // #5ce0d8 — logo bright teal
const NAVY = '\x1b[38;2;30;58;95m';      // #1e3a5f — logo dark navy
const GOLD = '\x1b[38;2;255;215;0m';     // #FFD700 — accent gold
const GREEN = '\x1b[38;2;16;185;129m';   // #10b981 — emerald
const RED = '\x1b[38;2;239;68;68m';      // red for errors
const SESSION_ID = 'tui:local';
const CHANNEL_ID = 'tui';
const AGENT_ID = HYBRIDAI_CHATBOT_ID || 'default';

let chatbotId = HYBRIDAI_CHATBOT_ID;
let enableRag = HYBRIDAI_ENABLE_RAG;
let botName = chatbotId || 'HybridClaw';
let activeRunAbortController: AbortController | null = null;

async function fetchBots(): Promise<HybridAIBot[]> {
  const url = `${HYBRIDAI_BASE_URL}/api/v1/bot-management/bots`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${HYBRIDAI_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch bots: ${res.status}`);
  const data = await res.json() as
    | { data?: Record<string, unknown>[]; bots?: Record<string, unknown>[]; items?: Record<string, unknown>[] }
    | Record<string, unknown>[];
  const raw = Array.isArray(data) ? data : (data.data || data.bots || data.items || []);
  // Normalize fields — API may return bot_name/chatbot_id instead of name/id
  return raw.map((item) => ({
    id: String(item.id ?? item._id ?? item.chatbot_id ?? item.bot_id ?? ''),
    name: String(item.bot_name ?? item.name ?? 'Unnamed'),
    description: item.description != null ? String(item.description) : undefined,
  }));
}

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
  console.log(`  \u{1F99E} ${BOLD}${TEAL}H y b r i d ${GOLD}C l a w${RESET} ${DIM}v0.1.0${RESET}`);
  console.log(`${DIM}     Powered by HybridAI${RESET}`);
  console.log();
  console.log(`${DIM}  Model: ${TEAL}${HYBRIDAI_MODEL}${RESET}${DIM} | Bot: ${GOLD}${botName}${RESET}`);
  console.log(`${DIM}  RAG: ${enableRag ? `${GREEN}on` : `${RED}off`}${RESET}${DIM} | Type ${TEAL}/help${RESET}${DIM} for commands${RESET}`);
  console.log();
}

function printHelp(): void {
  console.log();
  console.log(`  ${BOLD}${GOLD}Commands${RESET}`);
  console.log(`  ${TEAL}/help${RESET}        Show this help`);
  console.log(`  ${TEAL}/bots${RESET}        List available bots`);
  console.log(`  ${TEAL}/bot <id>${RESET}    Switch to a different bot`);
  console.log(`  ${TEAL}/rag${RESET}         Toggle RAG on/off`);
  console.log(`  ${TEAL}/info${RESET}        Show current settings`);
  console.log(`  ${TEAL}/clear${RESET}       Clear conversation history`);
  console.log(`  ${TEAL}/skill <name>${RESET} Run an installed skill`);
  console.log(`  ${TEAL}/stop${RESET}        Interrupt current activity`);
  console.log(`  ${TEAL}/exit${RESET}        Quit`);
  console.log(`  ${TEAL}ESC${RESET}          Interrupt current activity`);
  console.log();
}

function printToolUsage(tools: string[]): void {
  if (tools.length > 0) {
    console.log(`${DIM}  \u{1F99E} tools: ${TEAL}${tools.join(', ')}${RESET}`);
  }
}

function printResponse(text: string): void {
  console.log();
  const lines = text.split('\n');
  for (const line of lines) {
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

function spinner(): { stop: () => void; addTool: (toolName: string, preview?: string) => void; clearTools: () => void } {
  const dots = ['   ', '.  ', '.. ', '...'];
  let i = 0;
  let transientToolLines = 0;
  const clearLine = () => process.stdout.write('\r\x1b[2K');
  const render = () => {
    clearLine();
    process.stdout.write(`\r  ${TEAL}thinking${dots[i % dots.length]}${RESET}   `);
    i++;
  };

  const interval = setInterval(() => {
    render();
  }, 400);
  render();

  return {
    stop: () => {
      clearInterval(interval);
      clearLine();
    },
    addTool: (toolName: string, preview?: string) => {
      clearLine();
      const previewText = preview ? ` ${DIM}${preview}${RESET}` : '';
      process.stdout.write(`  \u{1F99E} ${TEAL}${toolName}${RESET}${previewText}\n`);
      transientToolLines++;
      render();
    },
    clearTools: () => {
      if (transientToolLines <= 0) return;
      process.stdout.write(`\x1b[${transientToolLines}A`);
      for (let idx = 0; idx < transientToolLines; idx++) {
        clearLine();
        process.stdout.write('\x1b[M');
      }
      clearLine();
      transientToolLines = 0;
    },
  };
}

async function handleSlashCommand(input: string, rl: readline.Interface): Promise<boolean> {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case 'help':
      printHelp();
      return true;

    case 'exit':
    case 'quit':
    case 'q':
      console.log(`\n  \u{1F99E} ${GOLD}Snip snip! Goodbye!${RESET}\n`);
      rl.close();
      process.exit(0);

    case 'bots': {
      try {
        const bots = await fetchBots();
        if (bots.length === 0) {
          printInfo('No bots available.');
          return true;
        }
        console.log();
        for (const b of bots) {
          const current = b.id === chatbotId ? ` ${GREEN}(current)${RESET}` : '';
          console.log(`  ${BOLD}${b.name}${RESET} (${DIM}${b.id}${RESET})${current}`);
          if (b.description) console.log(`    ${DIM}${b.description}${RESET}`);
        }
        console.log();
      } catch (err) {
        printError(`Failed to fetch bots: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

    case 'bot': {
      if (!parts[1]) {
        printInfo(`Current bot: ${botName} (${chatbotId})`);
        return true;
      }
      chatbotId = parts[1];
      // Try to resolve name
      try {
        const bots = await fetchBots();
        // Allow matching by name or ID
        const match = bots.find((b) =>
          b.id === chatbotId || b.name.toLowerCase() === parts.slice(1).join(' ').toLowerCase()
        );
        if (match) {
          chatbotId = match.id;
          botName = match.name;
        } else {
          botName = chatbotId;
        }
      } catch {
        botName = chatbotId;
      }
      printInfo(`Switched to bot: ${botName} (${chatbotId})`);
      return true;
    }

    case 'rag':
      enableRag = !enableRag;
      printInfo(`RAG ${enableRag ? 'enabled' : 'disabled'}`);
      return true;

    case 'info':
      console.log();
      console.log(`  ${BOLD}Model:${RESET}  ${HYBRIDAI_MODEL}`);
      console.log(`  ${BOLD}Bot:${RESET}    ${botName} (${chatbotId})`);
      console.log(`  ${BOLD}RAG:${RESET}    ${enableRag ? 'on' : 'off'}`);
      console.log(`  ${BOLD}Base:${RESET}   ${HYBRIDAI_BASE_URL}`);
      console.log();
      return true;

    case 'clear':
      clearSessionHistory(SESSION_ID);
      printInfo('Conversation cleared.');
      return true;

    case 'stop':
    case 'abort':
      if (activeRunAbortController && !activeRunAbortController.signal.aborted) {
        activeRunAbortController.abort();
        printInfo('Stopping current activity...');
      } else {
        printInfo('No active activity to stop.');
      }
      return true;

    default:
      return false;
  }
}

async function processMessage(content: string): Promise<void> {
  const session = getOrCreateSession(SESSION_ID, null, CHANNEL_ID);

  // Build conversation history (before storing new message so it's not duplicated)
  const history = getConversationHistory(SESSION_ID, 40);
  const messages: ChatMessage[] = [];

  // Inject workspace context files + skills as system message
  const contextFiles = loadBootstrapFiles(AGENT_ID);
  const contextPrompt = buildContextPrompt(contextFiles);
  const skills = loadSkills(AGENT_ID);
  const skillsPrompt = buildSkillsPrompt(skills);
  const systemParts = [contextPrompt, skillsPrompt].filter(Boolean);
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  // Add conversation history + current message
  messages.push(...history.reverse().map((msg) => ({
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
  })));
  const expandedContent = expandSkillInvocation(content, skills);
  messages.push({ role: 'user', content: expandedContent });

  if (!chatbotId) {
    printError('No chatbot configured. Use /bot <id> or set HYBRIDAI_CHATBOT_ID env var.');
    return;
  }

  const s = spinner();
  const abortController = new AbortController();
  activeRunAbortController = abortController;
  let lastProgressTool: string | null = null;
  const onToolProgress = (event: ToolProgressEvent): void => {
    if (event.phase !== 'start') return;
    if (event.toolName === lastProgressTool) return;
    lastProgressTool = event.toolName;

    const previewRaw = event.preview?.replace(/\s+/g, ' ').trim();
    s.addTool(event.toolName, previewRaw ? previewRaw.slice(0, 80) : undefined);
  };

  try {
    const scheduledTasks = getTasksForSession(SESSION_ID);
    const output = await runAgent(
      SESSION_ID,
      messages,
      chatbotId,
      enableRag,
      HYBRIDAI_MODEL,
      AGENT_ID,
      CHANNEL_ID,
      scheduledTasks,
      undefined,
      onToolProgress,
      abortController.signal,
    );
    s.stop();
    s.clearTools();

    processSideEffects(output, SESSION_ID, CHANNEL_ID);

    if (output.status === 'error') {
      if ((output.error || '').includes('Interrupted by user')) return;
      printError(output.error || 'Unknown error');
      return;
    }

    const result = output.result || 'No response.';

    // Only persist messages after successful response
    storeMessage(SESSION_ID, 'tui-user', 'user', 'user', content);
    storeMessage(SESSION_ID, 'assistant', null, 'assistant', result);

    printToolUsage(output.toolsUsed);
    printResponse(result);
  } catch (err) {
    s.stop();
    s.clearTools();
    if (abortController.signal.aborted) return;
    printError(err instanceof Error ? err.message : String(err));
  } finally {
    if (activeRunAbortController === abortController) {
      activeRunAbortController = null;
    }
  }
}

let scheduledTaskCallback: ((text: string) => void) | null = null;

// OpenClaw style: isolated session, tools disabled, direct output
async function runScheduledTask(origSessionId: string, channelId: string, prompt: string, taskId: number): Promise<void> {
  const botId = chatbotId;
  if (!botId) return;

  // Isolated run — fresh session, no history, only cron tool available
  const cronSessionId = `cron:${taskId}`;
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  try {
    const output = await runAgent(cronSessionId, messages, botId, false, HYBRIDAI_MODEL, AGENT_ID, channelId, undefined, ['cron']);
    if (output.status === 'success' && output.result) {
      if (scheduledTaskCallback) {
        scheduledTaskCallback(output.result);
      } else {
        printResponse(output.result);
      }
    }
  } catch (err) {
    printError(`Scheduled task failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  // Suppress pino output for TUI
  logger.level = 'warn';

  initDatabase();

  // Ensure workspace bootstrap files exist
  ensureBootstrapFiles(AGENT_ID);

  // Resolve bot name on startup
  if (chatbotId) {
    try {
      const bots = await fetchBots();
      const bot = bots.find((b) => b.id === chatbotId);
      if (bot) botName = bot.name;
    } catch { /* use ID */ }
  }

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

  // First-run: send initial message so the agent self-bootstraps via BOOTSTRAP.md
  if (isBootstrapping(AGENT_ID)) {
    console.log(`  ${DIM}First run detected — hatching via BOOTSTRAP.md...${RESET}`);
    console.log();
    await processMessage('Wake up, my friend!');
  }

  // Start heartbeat and scheduler after bootstrap is done
  startHeartbeat(AGENT_ID, HEARTBEAT_INTERVAL, (text) => {
    if (/^\s*HEARTBEAT_?OK\s*$/i.test(text)) return; // suppress leaks
    printResponse(text);
    rl.prompt();
  });
  scheduledTaskCallback = (text) => {
    printResponse(text);
    rl.prompt();
  };
  startScheduler(runScheduledTask);

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, rl);
      if (handled) {
        rl.prompt();
        return;
      }
    }

    await processMessage(input);
    rl.prompt();
  });

  rl.on('close', () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    stopHeartbeat();
    stopScheduler();
    console.log(`\n${DIM}  Goodbye!${RESET}\n`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('TUI error:', err);
  process.exit(1);
});
