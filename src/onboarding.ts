import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { spawn } from 'child_process';

import { loadEnvFile } from './env.js';
import {
  acceptSecurityTrustModel,
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  isSecurityTrustAccepted,
  runtimeConfigPath,
  SECURITY_POLICY_VERSION,
} from './runtime-config.js';

interface HybridAIBot {
  id: string;
  name: string;
  description?: string;
}

interface ApiKeyValidationResult {
  ok: boolean;
  bots: HybridAIBot[];
  error?: string;
}

interface OnboardingOptions {
  force?: boolean;
  commandName?: string;
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const TEAL = '\x1b[38;2;92;224;216m';
const GOLD = '\x1b[38;2;255;215;0m';
const GREEN = '\x1b[38;2;16;185;129m';
const RED = '\x1b[38;2;239;68;68m';
const ICON_TITLE = '🪼';
const ICON_GENERAL = '🦞';
const ICON_PROMPT = '🦞';
const ICON_SETUP = '⚙️';
const ICON_LINK = '🔗';
const ICON_AUTH = '🔒';
const ICON_KEY = '🔑';
const ICON_PERSON = '👤';
const ICON_KEYBOARD = '⌨️';
const ICON_SUCCESS = '✅';
const ICON_ERROR = '❌';

const DEFAULT_BASE_URL = 'https://hybridai.one';
const DEFAULT_REGISTER_PATH = '/register';
const DEFAULT_LOGIN_PATH = '/login?next=/admin_api_keys';
const DEFAULT_VERIFY_PATH = '/verify_code';
const BOT_LIST_PATH = '/api/v1/bot-management/bots';
const API_KEY_RE = /\bhai-[A-Za-z0-9]{16,}\b/;
const SECURITY_ACK_TOKEN = 'ACCEPT';
const SECURITY_DOC_PATH = path.join(process.cwd(), 'SECURITY.md');

function ensureEnvFileFromExample(): boolean {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) return false;

  const envExamplePath = path.join(process.cwd(), '.env.example');
  if (!fs.existsSync(envExamplePath)) return false;

  fs.copyFileSync(envExamplePath, envPath);
  return true;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function resolveUrl(baseUrl: string, routeOrUrl: string): string {
  const trimmed = routeOrUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed) return baseUrl;
  return `${baseUrl}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`;
}

function parseErrorMessage(payload: unknown, fallback: string): string {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload || fallback;
  if (typeof payload !== 'object') return fallback;

  const asRecord = payload as Record<string, unknown>;
  if (typeof asRecord.message === 'string' && asRecord.message.trim()) return asRecord.message;
  if (typeof asRecord.error === 'string' && asRecord.error.trim()) return asRecord.error;
  if (asRecord.error && typeof asRecord.error === 'object') {
    const nested = asRecord.error as Record<string, unknown>;
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message;
  }

  return fallback;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }

  const text = await response.text().catch(() => '');
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractApiKeyFromInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const directMatch = trimmed.match(API_KEY_RE);
  if (directMatch?.[0]) return directMatch[0];

  try {
    const parsed = new URL(trimmed);
    const queryCandidates = [
      parsed.searchParams.get('api_key'),
      parsed.searchParams.get('token'),
      parsed.searchParams.get('key'),
    ];
    for (const candidate of queryCandidates) {
      if (!candidate) continue;
      const nestedMatch = candidate.match(API_KEY_RE);
      if (nestedMatch?.[0]) return nestedMatch[0];
      if (candidate.startsWith('hai-')) return candidate;
    }
  } catch {
    // Not a URL; fall back to plain-text heuristics.
  }

  if (trimmed.startsWith('hai-')) return trimmed;
  return null;
}

function getOpenCommand(url: string): { cmd: string; args: string[] } | null {
  if (process.platform === 'darwin') return { cmd: 'open', args: [url] };
  if (process.platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (process.platform === 'linux') return { cmd: 'xdg-open', args: [url] };
  return null;
}

async function tryOpenUrl(url: string): Promise<boolean> {
  const openCommand = getOpenCommand(url);
  if (!openCommand) return false;

  return new Promise((resolve) => {
    const child = spawn(openCommand.cmd, openCommand.args, {
      stdio: 'ignore',
      detached: true,
    });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function normalizeBots(payload: unknown): HybridAIBot[] {
  const data = payload as
    | { data?: Record<string, unknown>[]; bots?: Record<string, unknown>[]; items?: Record<string, unknown>[] }
    | Record<string, unknown>[];
  const raw = Array.isArray(data) ? data : (data?.data || data?.bots || data?.items || []);

  return raw
    .map((item) => ({
      id: String(item.id ?? item._id ?? item.chatbot_id ?? item.bot_id ?? ''),
      name: String(item.bot_name ?? item.name ?? 'Unnamed'),
      description: item.description != null ? String(item.description) : undefined,
    }))
    .filter((bot) => Boolean(bot.id));
}

async function validateApiKey(baseUrl: string, apiKey: string): Promise<ApiKeyValidationResult> {
  let response: Response;
  try {
    response = await fetch(resolveUrl(baseUrl, BOT_LIST_PATH), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return {
      ok: false,
      bots: [],
      error: `Could not validate API key (${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  const payload = await readResponsePayload(response);
  if (!response.ok) {
    return {
      ok: false,
      bots: [],
      error: parseErrorMessage(payload, `Validation failed with HTTP ${response.status}.`),
    };
  }

  return {
    ok: true,
    bots: normalizeBots(payload),
  };
}

function escapeEnvValue(value: string): string {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertEnvLine(content: string, key: string, value: string): string {
  const normalizedLine = `${key}=${escapeEnvValue(value)}`;
  const lineRe = new RegExp(`^\\s*${escapeRegex(key)}\\s*=.*$`, 'm');

  if (lineRe.test(content)) {
    return content.replace(lineRe, normalizedLine);
  }

  const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  return `${content}${prefix}${normalizedLine}\n`;
}

function saveEnvCredentials(apiKey: string, chatbotId: string | null): void {
  const envPath = path.join(process.cwd(), '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

  let updated = upsertEnvLine(existing, 'HYBRIDAI_API_KEY', apiKey);
  if (chatbotId) {
    updated = upsertEnvLine(updated, 'HYBRIDAI_CHATBOT_ID', chatbotId);
  }

  fs.writeFileSync(envPath, updated, 'utf-8');
}

function formatAcceptanceMeta(): string {
  const config = getRuntimeConfig();
  if (!isSecurityTrustAccepted(config)) return 'not accepted';
  const by = config.security.trustModelAcceptedBy || 'unspecified';
  const at = config.security.trustModelAcceptedAt;
  return `${at} (${config.security.trustModelVersion}; by ${by})`;
}

function printHeadline(text: string): void {
  console.log(`\n${ICON_TITLE} ${BOLD}${TEAL}${text}${RESET}\n`);
}

function printInfo(text: string): void {
  console.log(`${GOLD}${ICON_GENERAL}${RESET} ${text}`);
}

function printSetup(text: string): void {
  console.log(`${GOLD}${ICON_SETUP}${RESET} ${text}`);
}

function printLink(text: string): void {
  console.log(`${TEAL}${ICON_LINK}${RESET} ${text}`);
}

function printSuccess(text: string): void {
  console.log(`${GREEN}${ICON_SUCCESS}${RESET} ${text}`);
}

function printWarn(text: string): void {
  console.log(`${RED}${ICON_ERROR}${RESET} ${text}`);
}

function printMeta(label: string, value: string): void {
  console.log(`${DIM}${label}:${RESET} ${TEAL}${value}${RESET}`);
}

function styledPromptWithIcon(question: string, icon: string): string {
  return `${TEAL}${icon}${RESET} ${question}`;
}

async function promptRequired(
  rl: readline.Interface,
  question: string,
  icon = ICON_PROMPT,
): Promise<string> {
  while (true) {
    const value = (await rl.question(styledPromptWithIcon(question, icon))).trim();
    if (value) return value;
    printWarn('Please enter a value.');
  }
}

async function promptOptional(
  rl: readline.Interface,
  question: string,
  icon = ICON_PROMPT,
): Promise<string> {
  return (await rl.question(styledPromptWithIcon(question, icon))).trim();
}

async function promptYesNo(
  rl: readline.Interface,
  question: string,
  defaultYes = true,
  icon = ICON_PROMPT,
): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const raw = (await rl.question(styledPromptWithIcon(`${question}${suffix}`, icon))).trim().toLowerCase();
  if (!raw) return defaultYes;
  if (raw === 'y' || raw === 'yes') return true;
  if (raw === 'n' || raw === 'no') return false;
  return defaultYes;
}

async function chooseDefaultBot(
  rl: readline.Interface,
  bots: HybridAIBot[],
  fallbackBotId: string,
): Promise<string> {
  if (bots.length === 0) {
    const manual = await promptOptional(
      rl,
      'No bots found from API. Enter chatbot id manually (or leave empty to skip): ',
    );
    return manual || fallbackBotId;
  }

  const defaultBot = bots[0];
  console.log(`${TEAL}${ICON_TITLE}${RESET} Available bots:`);
  for (let i = 0; i < Math.min(10, bots.length); i++) {
    const bot = bots[i];
    console.log(`${TEAL}${i + 1}.${RESET} ${bot.name} ${DIM}(${bot.id})${RESET}`);
  }
  if (bots.length > 10) {
    console.log(`${DIM}...and ${bots.length - 10} more${RESET}`);
  }

  const selection = await promptOptional(
    rl,
    `Select default bot by number or id (Enter for ${defaultBot.id}): `,
    ICON_KEYBOARD,
  );

  if (!selection) return defaultBot.id;

  const asNumber = Number.parseInt(selection, 10);
  if (!Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= bots.length) {
    return bots[asNumber - 1].id;
  }

  const byId = bots.find((bot) => bot.id === selection);
  if (byId) return byId.id;

  return selection;
}

async function ensureSecurityTrustAcceptance(
  rl: readline.Interface,
  commandLabel: string,
  force: boolean,
): Promise<boolean> {
  const existingConfig = getRuntimeConfig();
  if (isSecurityTrustAccepted(existingConfig) && !force) return false;

  printHeadline('Security trust model acceptance');
  printInfo(`${commandLabel} requires explicit trust model acceptance before runtime starts.`);
  printMeta('Policy version', SECURITY_POLICY_VERSION);
  printMeta('Current acceptance', formatAcceptanceMeta());
  printLink(`Policy document: ${SECURITY_DOC_PATH}`);
  printInfo('Review SECURITY.md before continuing.');
  printInfo('Acceptance confirms you understand container/tool risks, data handling, and operator responsibilities.');
  console.log();

  const ready = await promptYesNo(rl, 'Have you reviewed SECURITY.md and the trust model?', true, ICON_AUTH);
  if (!ready) {
    throw new Error('Security trust model acceptance is required. Review SECURITY.md and rerun onboarding.');
  }

  while (true) {
    const token = await promptRequired(
      rl,
      `Type ${SECURITY_ACK_TOKEN} to accept SECURITY.md v${SECURITY_POLICY_VERSION}: `,
      ICON_AUTH,
    );
    if (token.trim().toUpperCase() === SECURITY_ACK_TOKEN) break;
    printWarn(`Token mismatch. Type exactly ${SECURITY_ACK_TOKEN} to proceed.`);
  }

  const acceptedBy = await promptOptional(
    rl,
    'Accepted by (name/email, optional): ',
    ICON_PERSON,
  );

  acceptSecurityTrustModel({
    acceptedBy: acceptedBy || null,
    policyVersion: SECURITY_POLICY_VERSION,
  });
  printSuccess(`Saved trust-model acceptance to ${runtimeConfigPath()}.`);
  console.log();
  return true;
}

export async function ensureHybridAICredentials(options: OnboardingOptions = {}): Promise<void> {
  loadEnvFile();
  const bootstrappedConfig = ensureRuntimeConfigFile();

  const existingKey = (process.env.HYBRIDAI_API_KEY || '').trim();
  const force = options.force === true;
  const securityAccepted = isSecurityTrustAccepted(getRuntimeConfig());
  const needsSecurityAcceptance = !securityAccepted || force;
  const needsApiCredentials = !existingKey || force;
  if (!needsSecurityAcceptance && !needsApiCredentials) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!securityAccepted) {
      throw new Error(
        'Security trust model is not accepted. Run `hybridclaw onboarding` in an interactive terminal to accept SECURITY.md.',
      );
    }
    throw new Error(
      'HYBRIDAI_API_KEY is missing. Run `hybridclaw onboarding` in an interactive terminal or set the key in .env.',
    );
  }

  const bootstrappedEnv = ensureEnvFileFromExample();
  if (bootstrappedEnv) loadEnvFile();

  const baseUrl = normalizeBaseUrl(getRuntimeConfig().hybridai.baseUrl || process.env.HYBRIDAI_BASE_URL || DEFAULT_BASE_URL);
  const registerPageUrl = resolveUrl(baseUrl, DEFAULT_REGISTER_PATH);
  const loginUrl = resolveUrl(baseUrl, DEFAULT_LOGIN_PATH);
  const commandLabel = options.commandName || 'hybridclaw';

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    printHeadline('HybridAI onboarding');
    if (bootstrappedEnv) {
      printSetup('Created `.env` from `.env.example` for first-run setup.');
    }
    if (bootstrappedConfig) {
      printSetup('Created `config.json` with validated defaults.');
    }
    await ensureSecurityTrustAcceptance(rl, commandLabel, force);

    if (existingKey && !force) {
      printSuccess('Security trust model already accepted and API key is present. No credential changes needed.');
      return;
    }

    printMeta('HYBRIDAI_BASE_URL', baseUrl);
    if (!existingKey) {
      printInfo(`No HYBRIDAI_API_KEY found. ${commandLabel} needs HybridAI credentials before it can start.`);
    } else {
      printSetup('Reconfiguring HybridAI credentials.');
    }
    console.log();

    const wantsNewAccount = await promptYesNo(rl, 'Create a new HybridAI account now?', true, ICON_PERSON);
    let email = '';

    if (wantsNewAccount) {
      console.log();
      const openRegister = await promptYesNo(
        rl,
        `Open registration page ${registerPageUrl} in browser now?`,
        true,
        ICON_PERSON,
      );
      if (openRegister) {
        const opened = await tryOpenUrl(registerPageUrl);
        if (!opened) {
          printWarn('Could not auto-open browser. Open the link manually.');
        }
      }
      email = await promptOptional(
        rl,
        'Optional: email used for registration (used for verify link): ',
        ICON_PERSON,
      );
      if (email) {
        const verifyUrl = resolveUrl(baseUrl, `${DEFAULT_VERIFY_PATH}?email=${encodeURIComponent(email)}`);
        printLink(`Verify your email here: ${verifyUrl}`);
      }
      await promptOptional(rl, 'When registration/email verification is done, press Enter...', ICON_PERSON);
      console.log();
    }

    const openLogin = await promptYesNo(
      rl,
      `Open login page ${loginUrl} in browser now?`,
      true,
      ICON_AUTH,
    );
    if (openLogin) {
      const opened = await tryOpenUrl(loginUrl);
      if (!opened) {
        printWarn('Could not auto-open browser. Open the link manually.');
      }
    }

    let seededApiKey = '';
    const pasted = await promptOptional(
      rl,
      'Paste API key or URL containing it (or press Enter to continue): ',
      ICON_KEY,
    );
    if (pasted) {
      seededApiKey = extractApiKeyFromInput(pasted) || '';
      if (!seededApiKey) {
        printWarn('Could not extract an API key from input; you can paste the raw key next.');
      }
    } else {
      await promptOptional(rl, 'When login/API key retrieval is done, press Enter...', ICON_AUTH);
    }

    let apiKey = seededApiKey;
    let validation: ApiKeyValidationResult = { ok: false, bots: [], error: 'No validation yet.' };
    while (true) {
      if (!apiKey) {
        const entered = await promptRequired(rl, 'HybridAI API key: ', ICON_KEY);
        apiKey = extractApiKeyFromInput(entered) || entered;
      }

      validation = await validateApiKey(baseUrl, apiKey);
      if (validation.ok) {
        printSuccess('API key validated successfully.');
        console.log();
        break;
      }

      printWarn(`Validation failed: ${validation.error}`);
      const retry = await promptYesNo(rl, 'Try entering the key again?', true);
      if (retry) {
        apiKey = '';
        continue;
      }

      const keepAnyway = await promptYesNo(rl, 'Save this key anyway?', false);
      if (keepAnyway) break;
      apiKey = '';
    }

    const fallbackChatbotId = (process.env.HYBRIDAI_CHATBOT_ID || '').trim();
    const chosenChatbotId = await chooseDefaultBot(
      rl,
      validation.ok ? validation.bots : [],
      fallbackChatbotId,
    );

    saveEnvCredentials(apiKey, chosenChatbotId || null);
    process.env.HYBRIDAI_API_KEY = apiKey;
    if (chosenChatbotId) process.env.HYBRIDAI_CHATBOT_ID = chosenChatbotId;

    console.log();
    printSuccess(`Saved credentials to ${path.join(process.cwd(), '.env')}.`);
    if (chosenChatbotId) {
      printSuccess(`Default bot set to: ${chosenChatbotId}`);
    } else {
      printInfo('No default bot selected. You can set HYBRIDAI_CHATBOT_ID later.');
    }
    console.log();
  } finally {
    rl.close();
  }
}
