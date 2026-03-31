import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import {
  getCodexAuthStatus,
  loginCodexInteractive,
} from './auth/codex-auth.js';
import { refreshRuntimeSecretsFromEnv } from './config/config.js';
import {
  acceptSecurityTrustModel,
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  isSecurityTrustAccepted,
  runtimeConfigPath,
  SECURITY_POLICY_VERSION,
  updateRuntimeConfig,
} from './config/runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from './config/runtime-paths.js';
import {
  resolveTuiCommandLabel,
  shouldPrintTuiStartHint,
} from './onboarding-tui-hint.js';
import { isCodexModel, resolveModelProvider } from './providers/factory.js';
import {
  fetchHybridAIAccountChatbotId,
  normalizeBots,
  normalizeHybridAIAccountChatbotId,
} from './providers/hybridai-bots.js';
import {
  ensureRuntimeInstructionCopies,
  resolveRuntimeInstructionPath,
} from './security/instruction-integrity.js';
import {
  loadRuntimeSecrets,
  runtimeSecretsPath,
  saveRuntimeSecrets,
} from './security/runtime-secrets.js';
import type { HybridAIBot } from './types/hybridai.js';
import { promptForSecretInput } from './utils/secret-prompt.js';

interface ApiKeyValidationResult {
  ok: boolean;
  bots: HybridAIBot[];
  accountChatbotId?: string;
  error?: string;
}

interface OnboardingOptions {
  force?: boolean;
  commandName?: string;
  preferredAuth?:
    | 'hybridai'
    | 'openai-codex'
    | 'openrouter'
    | 'mistral'
    | 'huggingface';
}

function isLocalProvider(
  provider: ReturnType<typeof resolveModelProvider>,
): boolean {
  return (
    provider === 'ollama' || provider === 'lmstudio' || provider === 'vllm'
  );
}

function trustModelDocPath(): string {
  ensureRuntimeInstructionCopies();
  return resolveRuntimeInstructionPath('TRUST_MODEL.md');
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

type TerminalTheme = 'dark' | 'light';

interface ThemePalette {
  muted: string;
  teal: string;
  gold: string;
  green: string;
  red: string;
}

const DARK_PALETTE: ThemePalette = {
  muted: '\x1b[38;2;170;184;204m',
  teal: '\x1b[38;2;92;224;216m',
  gold: '\x1b[38;2;255;215;0m',
  green: '\x1b[38;2;16;185;129m',
  red: '\x1b[38;2;239;68;68m',
};

const LIGHT_PALETTE: ThemePalette = {
  muted: '\x1b[38;2;88;99;116m',
  teal: '\x1b[38;2;0;122;128m',
  gold: '\x1b[38;2;138;97;0m',
  green: '\x1b[38;2;0;130;92m',
  red: '\x1b[38;2;185;28;28m',
};

function inferThemeFromColorFgBg(): TerminalTheme | null {
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

function resolveOnboardingTheme(): TerminalTheme {
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

const PALETTE =
  resolveOnboardingTheme() === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
const MUTED = PALETTE.muted;
const TEAL = PALETTE.teal;
const GOLD = PALETTE.gold;
const GREEN = PALETTE.green;
const RED = PALETTE.red;
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
const DEFAULT_REGISTER_PATH = '/register?context=hybridclaw';
const DEFAULT_LOGIN_PATH = '/login?context=hybridclaw&next=/admin_api_keys';
const DEFAULT_VERIFY_PATH = '/verify_code';
const BOT_LIST_PATH = '/api/v1/bot-management/bots';
const BOT_ME_PATH = '/api/v1/bot-management/me';
const API_KEY_RE = /\bhai-[A-Za-z0-9]{16,}\b/;
const SECURITY_ACK_TOKEN = 'ACCEPT';

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
  if (typeof asRecord.message === 'string' && asRecord.message.trim())
    return asRecord.message;
  if (typeof asRecord.error === 'string' && asRecord.error.trim())
    return asRecord.error;
  if (asRecord.error && typeof asRecord.error === 'object') {
    const nested = asRecord.error as Record<string, unknown>;
    if (typeof nested.message === 'string' && nested.message.trim())
      return nested.message;
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
  if (process.platform === 'win32')
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
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

async function validateApiKey(
  baseUrl: string,
  apiKey: string,
): Promise<ApiKeyValidationResult> {
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
      error: parseErrorMessage(
        payload,
        `Validation failed with HTTP ${response.status}.`,
      ),
    };
  }

  let accountChatbotId = '';
  try {
    const meResponse = await fetch(resolveUrl(baseUrl, BOT_ME_PATH), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (meResponse.ok) {
      accountChatbotId = normalizeHybridAIAccountChatbotId(
        await readResponsePayload(meResponse),
      );
    }
  } catch {
    // Keep bot-list validation success; the account chatbot is only a default hint.
  }

  return {
    ok: true,
    bots: normalizeBots(payload),
    accountChatbotId,
  };
}

function saveHybridAICredentials(apiKey: string): string {
  return saveRuntimeSecrets({ HYBRIDAI_API_KEY: apiKey });
}

function saveDefaultChatbotId(chatbotId: string): void {
  updateRuntimeConfig((draft) => {
    draft.hybridai.defaultChatbotId = chatbotId.trim();
  });
}

function saveDefaultModel(model: string): void {
  updateRuntimeConfig((draft) => {
    draft.hybridai.defaultModel = model.trim();
  });
}

async function maybeBackfillDefaultHybridAIChatbotId(params: {
  authMethod: OnboardingOptions['preferredAuth'] | 'hybridai';
  existingKey: string;
  forcePrint?: boolean;
}): Promise<boolean> {
  if (params.authMethod !== 'hybridai') return false;
  if (!params.existingKey.trim()) return false;

  const configuredChatbotId =
    getRuntimeConfig().hybridai.defaultChatbotId.trim();
  if (configuredChatbotId) return false;

  try {
    const chatbotId = (await fetchHybridAIAccountChatbotId()).trim();
    if (!chatbotId) return false;
    saveDefaultChatbotId(chatbotId);
    if (params.forcePrint) {
      printSuccess(`Default bot set to: ${chatbotId}`);
    }
    return true;
  } catch {
    return false;
  }
}

function defaultHybridAIModel(): string {
  const config = getRuntimeConfig();
  const current = config.hybridai.defaultModel.trim();
  if (current && resolveModelProvider(current) === 'hybridai') return current;
  const first = config.hybridai.models.find(
    (model) => resolveModelProvider(model) === 'hybridai',
  );
  return (first || 'gpt-4.1-mini').trim();
}

function defaultCodexModel(): string {
  const config = getRuntimeConfig();
  const current = config.hybridai.defaultModel.trim();
  if (current && isCodexModel(current)) return current;
  const first = config.codex.models.find((model) => isCodexModel(model));
  return (first || 'openai-codex/gpt-5-codex').trim();
}

function defaultOpenRouterModel(): string {
  const config = getRuntimeConfig();
  const current = config.hybridai.defaultModel.trim();
  if (current && resolveModelProvider(current) === 'openrouter') return current;
  const first = config.openrouter.models.find(
    (model) => resolveModelProvider(model) === 'openrouter',
  );
  return (first || '').trim();
}

function defaultMistralModel(): string {
  const config = getRuntimeConfig();
  const current = config.hybridai.defaultModel.trim();
  if (current && resolveModelProvider(current) === 'mistral') return current;
  const first = config.mistral.models.find(
    (model) => resolveModelProvider(model) === 'mistral',
  );
  return (first || '').trim();
}

function defaultHuggingFaceModel(): string {
  const config = getRuntimeConfig();
  const current = config.hybridai.defaultModel.trim();
  if (current && resolveModelProvider(current) === 'huggingface') {
    return current;
  }
  const first = config.huggingface.models.find(
    (model) => resolveModelProvider(model) === 'huggingface',
  );
  return (first || '').trim();
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
  console.log(`${MUTED}${label}:${RESET} ${TEAL}${value}${RESET}`);
}

function printTuiStartHint(commandLabel: string): void {
  if (!shouldPrintTuiStartHint(commandLabel)) return;
  printInfo(
    `Start HybridClaw now with \`${resolveTuiCommandLabel(commandLabel)}\`.`,
  );
}

function styledPromptWithIcon(question: string, icon: string): string {
  return `${TEAL}${icon}${RESET} ${question}`;
}

async function promptRequired(
  rl: readline.Interface,
  question: string,
  icon = ICON_PROMPT,
  secret = false,
): Promise<string> {
  while (true) {
    const prompt = styledPromptWithIcon(question, icon);
    const value = secret
      ? await promptForSecretInput({ prompt, rl })
      : (await rl.question(prompt)).trim();
    if (value) return value;
    printWarn('Please enter a value.');
  }
}

async function promptOptional(
  rl: readline.Interface,
  question: string,
  icon = ICON_PROMPT,
  secret = false,
): Promise<string> {
  const prompt = styledPromptWithIcon(question, icon);
  return secret
    ? await promptForSecretInput({ prompt, rl })
    : (await rl.question(prompt)).trim();
}

async function promptYesNo(
  rl: readline.Interface,
  question: string,
  defaultYes = true,
  icon = ICON_PROMPT,
): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const raw = (
    await rl.question(styledPromptWithIcon(`${question}${suffix}`, icon))
  )
    .trim()
    .toLowerCase();
  if (!raw) return defaultYes;
  if (raw === 'y' || raw === 'yes') return true;
  if (raw === 'n' || raw === 'no') return false;
  return defaultYes;
}

async function chooseDefaultBot(
  rl: readline.Interface,
  bots: HybridAIBot[],
  fallbackBotId: string,
  accountChatbotId = '',
): Promise<string> {
  if (bots.length === 0) {
    const manual = await promptOptional(
      rl,
      'No bots found from API. Enter chatbot id manually (or leave empty to skip): ',
    );
    return manual || fallbackBotId || accountChatbotId;
  }

  const defaultBotId = fallbackBotId || accountChatbotId || bots[0].id;
  console.log(`${TEAL}${ICON_TITLE}${RESET} Available bots:`);
  for (let i = 0; i < Math.min(10, bots.length); i++) {
    const bot = bots[i];
    console.log(
      `${TEAL}${i + 1}.${RESET} ${bot.name} ${MUTED}(${bot.id})${RESET}`,
    );
  }
  if (bots.length > 10) {
    console.log(`${MUTED}...and ${bots.length - 10} more${RESET}`);
  }

  const selection = await promptOptional(
    rl,
    `Select default bot by number or id (Enter for ${defaultBotId}): `,
    ICON_KEYBOARD,
  );

  if (!selection) return defaultBotId;

  const asNumber = Number.parseInt(selection, 10);
  if (!Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= bots.length) {
    return bots[asNumber - 1].id;
  }

  const byId = bots.find((bot) => bot.id === selection);
  if (byId) return byId.id;

  return selection;
}

async function promptAuthMethod(
  rl: readline.Interface,
  currentModel: string,
): Promise<
  'hybridai' | 'openai-codex' | 'openrouter' | 'mistral' | 'huggingface'
> {
  const currentProvider = resolveModelProvider(currentModel);
  const defaultChoice =
    currentProvider === 'openai-codex'
      ? '2'
      : currentProvider === 'openrouter'
        ? '3'
        : currentProvider === 'mistral'
          ? '4'
          : currentProvider === 'huggingface'
            ? '5'
            : '1';

  console.log(`${TEAL}${ICON_TITLE}${RESET} Auth methods:`);
  console.log(`  ${TEAL}1.${RESET} HybridAI API key`);
  console.log(`  ${TEAL}2.${RESET} OpenAI Codex (OAuth login)`);
  console.log(`  ${TEAL}3.${RESET} OpenRouter API key`);
  console.log(`  ${TEAL}4.${RESET} Mistral API key`);
  console.log(`  ${TEAL}5.${RESET} Hugging Face token`);

  while (true) {
    const choice = await promptOptional(
      rl,
      `Choose auth method (Enter for ${defaultChoice}): `,
      ICON_AUTH,
    );
    const normalized = (choice || defaultChoice).trim().toLowerCase();
    if (normalized === '1' || normalized === 'hybridai') return 'hybridai';
    if (
      normalized === '2' ||
      normalized === 'codex' ||
      normalized === 'openai-codex'
    ) {
      return 'openai-codex';
    }
    if (normalized === '3' || normalized === 'openrouter') {
      return 'openrouter';
    }
    if (normalized === '4' || normalized === 'mistral') {
      return 'mistral';
    }
    if (
      normalized === '5' ||
      normalized === 'huggingface' ||
      normalized === 'hf'
    ) {
      return 'huggingface';
    }
    printWarn(
      'Enter 1 for HybridAI, 2 for OpenAI Codex, 3 for OpenRouter, 4 for Mistral, or 5 for Hugging Face.',
    );
  }
}

async function maybeSwitchDefaultModel(
  rl: readline.Interface,
  targetModel: string,
  reason: string,
): Promise<boolean> {
  const currentModel = getRuntimeConfig().hybridai.defaultModel.trim();
  if (!targetModel || currentModel === targetModel) return false;

  const shouldSwitch = await promptYesNo(
    rl,
    `${reason} Set default model to ${targetModel}?`,
    true,
    ICON_SETUP,
  );
  if (!shouldSwitch) return false;

  saveDefaultModel(targetModel);
  return true;
}

async function ensureSecurityTrustAcceptance(
  rl: readline.Interface,
  commandLabel: string,
  force: boolean,
): Promise<boolean> {
  const existingConfig = getRuntimeConfig();
  if (isSecurityTrustAccepted(existingConfig) && !force) return false;

  printHeadline('Security trust model acceptance');
  printInfo(
    `${commandLabel} requires explicit trust model acceptance before runtime starts.`,
  );
  printMeta('Policy version', SECURITY_POLICY_VERSION);
  printMeta('Current acceptance', formatAcceptanceMeta());
  printLink(`Policy document: ${trustModelDocPath()}`);
  printInfo('Review TRUST_MODEL.md before continuing.');
  printInfo(
    'Acceptance confirms you understand container/tool risks, data handling, and operator responsibilities.',
  );
  console.log();

  const ready = await promptYesNo(
    rl,
    'Have you reviewed TRUST_MODEL.md and the trust model?',
    true,
    ICON_AUTH,
  );
  if (!ready) {
    throw new Error(
      'Security trust model acceptance is required. Review TRUST_MODEL.md and rerun onboarding.',
    );
  }

  while (true) {
    const token = await promptRequired(
      rl,
      `Type ${SECURITY_ACK_TOKEN} to accept TRUST_MODEL.md v${SECURITY_POLICY_VERSION}: `,
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

async function runHybridAIApiKeyOnboarding(params: {
  rl: readline.Interface;
  baseUrl: string;
  commandLabel: string;
  existingKey: string;
}): Promise<void> {
  const { rl, commandLabel, existingKey } = params;
  const baseUrl = normalizeBaseUrl(
    params.baseUrl || getRuntimeConfig().hybridai.baseUrl || DEFAULT_BASE_URL,
  );
  const registerPageUrl = resolveUrl(baseUrl, DEFAULT_REGISTER_PATH);
  const loginUrl = resolveUrl(baseUrl, DEFAULT_LOGIN_PATH);
  printMeta('HYBRIDAI_BASE_URL', baseUrl);
  if (!existingKey) {
    printInfo(
      `No HYBRIDAI_API_KEY found. ${commandLabel} needs HybridAI credentials before it can start.`,
    );
  } else {
    printSetup('Reconfiguring HybridAI credentials.');
  }
  console.log();

  const wantsNewAccount = await promptYesNo(
    rl,
    'Create a new HybridAI account now?',
    true,
    ICON_PERSON,
  );
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
      const verifyUrl = resolveUrl(
        baseUrl,
        `${DEFAULT_VERIFY_PATH}?email=${encodeURIComponent(email)}`,
      );
      printLink(`Verify your email here: ${verifyUrl}`);
    }
    await promptOptional(
      rl,
      'When registration/email verification is done, press Enter...',
      ICON_PERSON,
    );
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
    true,
  );
  if (pasted) {
    seededApiKey = extractApiKeyFromInput(pasted) || '';
    if (!seededApiKey) {
      printWarn(
        'Could not extract an API key from input; you can paste the raw key next.',
      );
    }
  } else {
    await promptOptional(
      rl,
      'When login/API key retrieval is done, press Enter...',
      ICON_AUTH,
    );
  }

  let apiKey = seededApiKey;
  let validation: ApiKeyValidationResult = {
    ok: false,
    bots: [],
    error: 'No validation yet.',
  };
  while (true) {
    if (!apiKey) {
      const entered = await promptRequired(
        rl,
        'HybridAI API key: ',
        ICON_KEY,
        true,
      );
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

  const fallbackChatbotId = getRuntimeConfig().hybridai.defaultChatbotId.trim();
  const chosenChatbotId = await chooseDefaultBot(
    rl,
    validation.ok ? validation.bots : [],
    fallbackChatbotId,
    validation.accountChatbotId || '',
  );

  const secretsPath = saveHybridAICredentials(apiKey);
  saveDefaultChatbotId(chosenChatbotId || '');
  process.env.HYBRIDAI_API_KEY = apiKey;
  refreshRuntimeSecretsFromEnv();
  const switchedModel = await maybeSwitchDefaultModel(
    rl,
    defaultHybridAIModel(),
    'HybridAI auth works only with HybridAI models.',
  );

  console.log();
  printSuccess(`Saved credentials to ${secretsPath}.`);
  printSuccess(`Saved runtime settings to ${runtimeConfigPath()}.`);
  if (chosenChatbotId) {
    printSuccess(`Default bot set to: ${chosenChatbotId}`);
  } else {
    printInfo(
      `No default bot selected. You can set hybridai.defaultChatbotId in ${runtimeConfigPath()} later.`,
    );
  }
  if (switchedModel) {
    printSuccess(`Default model set to: ${defaultHybridAIModel()}`);
  }
  printTuiStartHint(commandLabel);
  console.log();
}

async function runCodexOnboarding(params: {
  rl: readline.Interface;
  commandLabel: string;
}): Promise<void> {
  const { rl, commandLabel } = params;
  const existing = getCodexAuthStatus();
  if (existing.authenticated) {
    printSetup('Reconfiguring OpenAI Codex credentials.');
  } else {
    printInfo('No OpenAI Codex OAuth session found. Starting login.');
  }
  console.log();

  const result = await (async () => {
    rl.pause();
    try {
      return await loginCodexInteractive({ method: 'auto' });
    } finally {
      rl.resume();
    }
  })();

  const switchedModel = await maybeSwitchDefaultModel(
    rl,
    defaultCodexModel(),
    'OpenAI Codex auth works only with Codex models.',
  );

  console.log();
  printSuccess(`Saved Codex credentials to ${result.path}.`);
  printSuccess(`Account: ${result.credentials.accountId}`);
  printSuccess(`Login method: ${result.method}`);
  if (switchedModel) {
    printSuccess(`Default model set to: ${defaultCodexModel()}`);
  }
  printTuiStartHint(commandLabel);
  console.log();
}

async function runOpenRouterOnboarding(params: {
  rl: readline.Interface;
  commandLabel: string;
  existingKey: string;
}): Promise<void> {
  const { rl, commandLabel, existingKey } = params;
  const runtimeConfig = getRuntimeConfig();
  printMeta('OPENROUTER_BASE_URL', runtimeConfig.openrouter.baseUrl);
  if (existingKey) {
    printSetup('Reconfiguring OpenRouter credentials.');
  } else {
    printInfo(
      `No OPENROUTER_API_KEY found. ${commandLabel} needs OpenRouter credentials before it can start.`,
    );
  }
  console.log();

  const entered = await promptOptional(
    rl,
    existingKey
      ? 'OpenRouter API key (Enter to keep current): '
      : 'OpenRouter API key: ',
    ICON_KEY,
  );
  const apiKey = (entered || existingKey).trim();
  if (!apiKey) {
    throw new Error('OpenRouter onboarding requires a non-empty API key.');
  }

  const secretsPath = saveRuntimeSecrets({ OPENROUTER_API_KEY: apiKey });
  process.env.OPENROUTER_API_KEY = apiKey;
  refreshRuntimeSecretsFromEnv();

  const nextOpenRouterModel = defaultOpenRouterModel();
  const switchedModel = await maybeSwitchDefaultModel(
    rl,
    nextOpenRouterModel,
    'OpenRouter auth works only with OpenRouter models.',
  );

  console.log();
  printSuccess(`Saved credentials to ${secretsPath}.`);
  printSuccess(`Saved runtime settings to ${runtimeConfigPath()}.`);
  if (switchedModel) {
    printSuccess(`Default model set to: ${nextOpenRouterModel}`);
  } else if (!nextOpenRouterModel) {
    printInfo(
      `No OpenRouter default model is configured. Set hybridai.defaultModel to an openrouter/... model in ${runtimeConfigPath()} if needed.`,
    );
  }
  printTuiStartHint(commandLabel);
  console.log();
}

async function runMistralOnboarding(params: {
  rl: readline.Interface;
  commandLabel: string;
  existingKey: string;
}): Promise<void> {
  const { rl, commandLabel, existingKey } = params;
  const runtimeConfig = getRuntimeConfig();
  printMeta('MISTRAL_BASE_URL', runtimeConfig.mistral.baseUrl);
  if (existingKey) {
    printSetup('Reconfiguring Mistral credentials.');
  } else {
    printInfo(
      `No MISTRAL_API_KEY found. ${commandLabel} needs Mistral credentials before it can start.`,
    );
  }
  console.log();

  const entered = await promptOptional(
    rl,
    existingKey
      ? 'Mistral API key (Enter to keep current): '
      : 'Mistral API key: ',
    ICON_KEY,
  );
  const apiKey = (entered || existingKey).trim();
  if (!apiKey) {
    throw new Error('Mistral onboarding requires a non-empty API key.');
  }

  const secretsPath = saveRuntimeSecrets({ MISTRAL_API_KEY: apiKey });
  process.env.MISTRAL_API_KEY = apiKey;
  refreshRuntimeSecretsFromEnv();

  const nextMistralModel = defaultMistralModel();
  const switchedModel = await maybeSwitchDefaultModel(
    rl,
    nextMistralModel,
    'Mistral auth works only with Mistral models.',
  );

  console.log();
  printSuccess(`Saved credentials to ${secretsPath}.`);
  printSuccess(`Saved runtime settings to ${runtimeConfigPath()}.`);
  if (switchedModel) {
    printSuccess(`Default model set to: ${nextMistralModel}`);
  } else if (!nextMistralModel) {
    printInfo(
      `No Mistral default model is configured. Set hybridai.defaultModel to a mistral/... model in ${runtimeConfigPath()} if needed.`,
    );
  }
  printTuiStartHint(commandLabel);
  console.log();
}

async function runHuggingFaceOnboarding(params: {
  rl: readline.Interface;
  commandLabel: string;
  existingKey: string;
}): Promise<void> {
  const { rl, commandLabel, existingKey } = params;
  const runtimeConfig = getRuntimeConfig();
  printMeta('HUGGINGFACE_BASE_URL', runtimeConfig.huggingface.baseUrl);
  if (existingKey) {
    printSetup('Reconfiguring Hugging Face credentials.');
  } else {
    printInfo(
      `No HF_TOKEN found. ${commandLabel} needs Hugging Face credentials before it can start.`,
    );
  }
  console.log();

  const entered = await promptOptional(
    rl,
    existingKey
      ? 'Hugging Face token (Enter to keep current): '
      : 'Hugging Face token: ',
    ICON_KEY,
  );
  const apiKey = (entered || existingKey).trim();
  if (!apiKey) {
    throw new Error('Hugging Face onboarding requires a non-empty token.');
  }

  const secretsPath = saveRuntimeSecrets({ HF_TOKEN: apiKey });
  process.env.HF_TOKEN = apiKey;
  process.env.HUGGINGFACE_API_KEY = apiKey;
  refreshRuntimeSecretsFromEnv();

  const nextHuggingFaceModel = defaultHuggingFaceModel();
  const switchedModel = await maybeSwitchDefaultModel(
    rl,
    nextHuggingFaceModel,
    'Hugging Face auth works only with Hugging Face models.',
  );

  console.log();
  printSuccess(`Saved credentials to ${secretsPath}.`);
  printSuccess(`Saved runtime settings to ${runtimeConfigPath()}.`);
  if (switchedModel) {
    printSuccess(`Default model set to: ${nextHuggingFaceModel}`);
  } else if (!nextHuggingFaceModel) {
    printInfo(
      `No Hugging Face default model is configured. Set hybridai.defaultModel to a huggingface/... model in ${runtimeConfigPath()} if needed.`,
    );
  }
  printTuiStartHint(commandLabel);
  console.log();
}

export async function ensureRuntimeCredentials(
  options: OnboardingOptions = {},
): Promise<void> {
  loadRuntimeSecrets();
  const bootstrappedConfig = ensureRuntimeConfigFile();

  const runtimeConfig = getRuntimeConfig();
  const existingKey = (process.env.HYBRIDAI_API_KEY || '').trim();
  const existingOpenRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const existingMistralKey = (process.env.MISTRAL_API_KEY || '').trim();
  const existingHuggingFaceKey = (
    process.env.HF_TOKEN ||
    process.env.HUGGINGFACE_API_KEY ||
    ''
  ).trim();
  const codexStatus = getCodexAuthStatus();
  const currentModel = runtimeConfig.hybridai.defaultModel.trim();
  const resolvedCurrentProvider = resolveModelProvider(currentModel);
  const currentProviderIsLocal = isLocalProvider(resolvedCurrentProvider);
  const currentAuth =
    options.preferredAuth ||
    (resolvedCurrentProvider === 'openai-codex'
      ? 'openai-codex'
      : resolvedCurrentProvider === 'openrouter'
        ? 'openrouter'
        : resolvedCurrentProvider === 'mistral'
          ? 'mistral'
          : resolvedCurrentProvider === 'huggingface'
            ? 'huggingface'
            : 'hybridai');
  const force = options.force === true;
  let securityAccepted = isSecurityTrustAccepted(runtimeConfig);
  const needsSecurityAcceptance = !securityAccepted || force;
  const hasRequiredCredentials = currentProviderIsLocal
    ? true
    : currentAuth === 'openai-codex'
      ? codexStatus.authenticated
      : currentAuth === 'openrouter'
        ? !!existingOpenRouterKey
        : currentAuth === 'mistral'
          ? !!existingMistralKey
          : currentAuth === 'huggingface'
            ? !!existingHuggingFaceKey
            : !!existingKey;
  if (!needsSecurityAcceptance && hasRequiredCredentials) {
    await maybeBackfillDefaultHybridAIChatbotId({
      authMethod: currentAuth,
      existingKey,
    });
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!securityAccepted) {
      if (process.env.HYBRIDCLAW_ACCEPT_TRUST === 'true') {
        try {
          acceptSecurityTrustModel({
            acceptedBy: 'env:HYBRIDCLAW_ACCEPT_TRUST',
          });
        } catch (err) {
          throw new Error(
            `Failed to persist trust acceptance (HYBRIDCLAW_ACCEPT_TRUST=true). ` +
              `Check that ${DEFAULT_RUNTIME_HOME_DIR} is writable. ` +
              `Cause: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        securityAccepted = true;
      } else {
        throw new Error(
          'Security trust model is not accepted. Run `hybridclaw onboarding` in an interactive terminal to accept TRUST_MODEL.md, or set HYBRIDCLAW_ACCEPT_TRUST=true to accept automatically.',
        );
      }
    }
    // After accepting trust via env var, credentials may already be present.
    if (hasRequiredCredentials) return;
    if (currentAuth === 'openai-codex') {
      throw new Error(
        'OpenAI Codex credentials are missing. Run `hybridclaw codex login` or `hybridclaw onboarding` in an interactive terminal.',
      );
    }
    if (currentAuth === 'openrouter') {
      throw new Error(
        `OPENROUTER_API_KEY is missing. Run \`hybridclaw onboarding\` in an interactive terminal or store it in ${runtimeSecretsPath()}.`,
      );
    }
    if (currentAuth === 'mistral') {
      throw new Error(
        `MISTRAL_API_KEY is missing. Run \`hybridclaw onboarding\` in an interactive terminal or store it in ${runtimeSecretsPath()}.`,
      );
    }
    if (currentAuth === 'huggingface') {
      throw new Error(
        `HF_TOKEN is missing. Run \`hybridclaw onboarding\` in an interactive terminal or store it in ${runtimeSecretsPath()}.`,
      );
    }
    throw new Error(
      `HYBRIDAI_API_KEY is missing. Run \`hybridclaw onboarding\` in an interactive terminal or store it in ${runtimeSecretsPath()}.`,
    );
  }

  const baseUrl = normalizeBaseUrl(
    runtimeConfig.hybridai.baseUrl ||
      process.env.HYBRIDAI_BASE_URL ||
      DEFAULT_BASE_URL,
  );
  const commandLabel = options.commandName || 'hybridclaw';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    printHeadline('HybridClaw onboarding');
    if (bootstrappedConfig) {
      printSetup(
        `Created runtime config with validated defaults at ${runtimeConfigPath()}.`,
      );
    }
    await ensureSecurityTrustAcceptance(rl, commandLabel, force);

    if (currentProviderIsLocal && !options.preferredAuth) {
      printSuccess(
        'Security trust model accepted and the active model provider is local. No remote credentials are required.',
      );
      return;
    }

    if (hasRequiredCredentials && !force) {
      await maybeBackfillDefaultHybridAIChatbotId({
        authMethod: currentAuth,
        existingKey,
        forcePrint: true,
      });
      printSuccess(
        'Security trust model already accepted and the active model provider is configured.',
      );
      return;
    }

    const authMethod =
      options.preferredAuth || (await promptAuthMethod(rl, currentModel));
    if (authMethod === 'openai-codex') {
      await runCodexOnboarding({ rl, commandLabel });
      return;
    }
    if (authMethod === 'openrouter') {
      await runOpenRouterOnboarding({
        rl,
        commandLabel,
        existingKey: existingOpenRouterKey,
      });
      return;
    }
    if (authMethod === 'mistral') {
      await runMistralOnboarding({
        rl,
        commandLabel,
        existingKey: existingMistralKey,
      });
      return;
    }
    if (authMethod === 'huggingface') {
      await runHuggingFaceOnboarding({
        rl,
        commandLabel,
        existingKey: existingHuggingFaceKey,
      });
      return;
    }

    await runHybridAIApiKeyOnboarding({
      rl,
      baseUrl,
      commandLabel,
      existingKey,
    });
  } finally {
    rl.close();
  }
}
