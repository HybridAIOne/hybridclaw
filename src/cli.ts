#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  CodexAuthError,
  clearCodexCredentials,
  getCodexAuthStatus,
  loginCodexInteractive,
} from './auth/codex-auth.js';
import {
  clearHybridAICredentials,
  getHybridAIAuthStatus,
  loginHybridAIInteractive,
} from './auth/hybridai-auth.js';
import {
  normalizeEmailAddress,
  normalizeEmailAllowEntry,
} from './channels/email/allowlist.js';
import {
  getWhatsAppAuthStatus,
  resetWhatsAppAuthState,
  WHATSAPP_AUTH_DIR,
  WhatsAppAuthLockError,
} from './channels/whatsapp/auth.js';
import { createWhatsAppConnectionManager } from './channels/whatsapp/connection.js';
import { normalizePhoneNumber } from './channels/whatsapp/phone.js';
import {
  findUnsupportedGatewayLifecycleFlag,
  parseGatewayFlags,
  type SandboxModeOverride,
} from './config/cli-flags.js';
import {
  APP_VERSION,
  DATA_DIR,
  GATEWAY_BASE_URL,
  getResolvedSandboxMode,
  MissingRequiredEnvVarError,
  setSandboxModeOverride,
} from './config/config.js';
import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  runtimeConfigPath,
  updateRuntimeConfig,
} from './config/runtime-config.js';
import { ensureRuntimeCredentials } from './onboarding.js';
import type { LocalBackendType } from './providers/local-types.js';
import {
  runtimeSecretsPath,
  saveRuntimeSecrets,
} from './security/runtime-secrets.js';
import { printUpdateUsage, runUpdateCommand } from './update.js';
import { sleep } from './utils/sleep.js';

const PACKAGE_NAME = '@hybridaione/hybridclaw';
let cachedInstallRoot: string | null = null;

function resolveWhatsAppSetupSettleMs(): number {
  const raw = String(
    process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS || '',
  ).trim();
  if (!raw) return 8_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 8_000;
  return Math.floor(parsed);
}

function resolveInstallRoot(): string {
  if (cachedInstallRoot) return cachedInstallRoot;
  let current = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(packageJsonPath, 'utf-8'),
        ) as Partial<{ name: string }>;
        if (parsed.name === PACKAGE_NAME) {
          cachedInstallRoot = current;
          return cachedInstallRoot;
        }
      } catch {
        // ignore parse errors and continue searching upward
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  cachedInstallRoot = process.cwd();
  return cachedInstallRoot;
}

async function ensureRuntimeContainer(
  commandName: string,
  required = true,
  sandboxMode: SandboxModeOverride | null = null,
): Promise<void> {
  if ((sandboxMode || getResolvedSandboxMode()) === 'host') return;
  const { ensureContainerImageReady } = await import(
    './infra/container-setup.js'
  );
  await ensureContainerImageReady({
    commandName,
    required,
    cwd: resolveInstallRoot(),
  });
}

async function isGatewayReachable(): Promise<boolean> {
  const { gatewayHealth, gatewayStatus } = await import(
    './gateway/gateway-client.js'
  );
  try {
    await gatewayHealth();
    return true;
  } catch {
    try {
      await gatewayStatus();
      return true;
    } catch {
      return false;
    }
  }
}

async function ensureGatewayForTui(commandName: string): Promise<void> {
  if (await isGatewayReachable()) {
    console.log(`${commandName}: Gateway found at ${GATEWAY_BASE_URL}.`);
    return;
  }

  console.log(
    `${commandName}: Gateway not found. Starting gateway backend at ${GATEWAY_BASE_URL}.`,
  );
  await startGatewayBackend(commandName, true);

  if (!(await isGatewayReachable())) {
    throw new Error(
      `Gateway did not become available at ${GATEWAY_BASE_URL} after startup.` +
        ' Please run `hybridclaw gateway start --foreground` in another terminal and try again.',
    );
  }
}

function formatInstructionDiffLine(file: {
  path: string;
  status: 'ok' | 'modified' | 'missing' | 'source_missing';
  sourcePath: string;
  runtimePath: string;
  expectedHash: string | null;
  actualHash: string | null;
}): string[] {
  if (file.status === 'modified') {
    return [
      `  - modified ${file.path}`,
      `    source   ${file.sourcePath}`,
      `    runtime  ${file.runtimePath}`,
      `    expected ${file.expectedHash}`,
      `    actual   ${file.actualHash}`,
    ];
  }
  if (file.status === 'missing') {
    return [
      `  - missing  ${file.path}`,
      `    source   ${file.sourcePath}`,
      `    runtime  ${file.runtimePath}`,
      `    expected ${file.expectedHash}`,
      '    actual   <missing>',
    ];
  }
  return [
    `  - missing source ${file.path}`,
    `    source   ${file.sourcePath}`,
    `    runtime  ${file.runtimePath}`,
    '    expected <missing source>',
    `    actual   ${file.actualHash || '<missing>'}`,
  ];
}

async function ensureTuiInstructionApproval(
  commandName: string,
): Promise<void> {
  const {
    summarizeInstructionIntegrity,
    syncRuntimeInstructionCopies,
    verifyInstructionIntegrity,
  } = await import('./security/instruction-integrity.js');
  const { beginInstructionApprovalAudit, completeInstructionApprovalAudit } =
    await import('./security/instruction-approval-audit.js');

  const result = verifyInstructionIntegrity();
  if (result.ok) return;
  const summary = summarizeInstructionIntegrity(result);
  const auditContext = beginInstructionApprovalAudit({
    sessionId: 'tui:local',
    source: 'tui.startup',
    description: `TUI startup instruction sync required (${summary}).`,
  });

  console.error(`${commandName}: instruction integrity check failed.`);
  console.error(
    `Runtime instruction copies under ${result.runtimeRoot} differ from installed sources in ${result.installRoot}.`,
  );

  const changed = result.files.filter((file) => file.status !== 'ok');
  if (changed.length > 0) {
    console.error('Instruction file differences:');
    for (const file of changed) {
      for (const line of formatInstructionDiffLine(file)) {
        console.error(line);
      }
    }
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    completeInstructionApprovalAudit({
      context: auditContext,
      approved: false,
      approvedBy: 'policy-engine',
      method: 'policy',
      description: `TUI startup blocked: non-interactive instruction sync required (${summary}).`,
    });
    throw new Error(
      'Instruction runtime copies are modified. Run `hybridclaw audit instructions --sync` and try again.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let answer = '';
  try {
    answer = (
      await rl.question(
        'Restore runtime instruction files from installed defaults now? [y/N] ',
      )
    )
      .trim()
      .toLowerCase();
  } finally {
    rl.close();
  }

  if (answer !== 'y' && answer !== 'yes') {
    completeInstructionApprovalAudit({
      context: auditContext,
      approved: false,
      approvedBy: 'local-user',
      method: 'interactive',
      description: `User declined TUI instruction sync (${summary}).`,
    });
    throw new Error(
      'Instruction restore required. Run `hybridclaw audit instructions --sync` and restart TUI.',
    );
  }

  try {
    const synced = syncRuntimeInstructionCopies();
    console.log(
      `Restored runtime instruction files at ${synced.runtimeRoot} (${synced.syncedAt}).`,
    );
    completeInstructionApprovalAudit({
      context: auditContext,
      approved: true,
      approvedBy: 'local-user',
      method: 'interactive',
      description: `User restored runtime instruction files (${synced.syncedAt}).`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    completeInstructionApprovalAudit({
      context: auditContext,
      approved: false,
      approvedBy: 'local-user',
      method: 'interactive',
      description: `TUI instruction sync failed (${message}).`,
    });
    throw err;
  }
}

function printMainUsage(): void {
  console.log(`Usage: hybridclaw <command>

  Commands:
  auth       Unified provider login/logout/status
  gateway    Manage core runtime (start/stop/status) or run gateway commands
  tui        Start terminal adapter (starts gateway automatically when needed)
  onboarding Run interactive auth + trust-model onboarding
  channels   Channel setup helpers (Discord, WhatsApp, Email)
  local      Deprecated alias for local provider setup/status
  hybridai   Deprecated alias for HybridAI provider auth
  codex      Deprecated alias for Codex provider auth
  skill      List skill dependency installers or run one
  update     Check and apply HybridClaw CLI updates
  audit      Inspect/verify structured audit trail
  help       Show general or topic-specific help (e.g. \`hybridclaw help gateway\`)

  Options:
  --version, -v  Show HybridClaw CLI version`);
}

function printGatewayUsage(): void {
  console.log(`Usage: hybridclaw gateway <subcommand>

Commands:
  hybridclaw gateway
  hybridclaw gateway start [--foreground] [--debug] [--sandbox=container|host]
  hybridclaw gateway restart [--foreground] [--debug] [--sandbox=container|host]
  hybridclaw gateway stop
  hybridclaw gateway status
  hybridclaw gateway sessions
  hybridclaw gateway bot info
  hybridclaw gateway show [all|thinking|tools|none]
  hybridclaw gateway reset [yes|no]
  hybridclaw gateway <discord-style command ...>`);
}

function printTuiUsage(): void {
  console.log(`Usage: hybridclaw tui

Starts the terminal adapter and connects to the running gateway.
If gateway is not running, it is started in backend mode automatically.

Interactive slash commands inside TUI:
  /help   /status   /approve [view|yes|session|agent|no] [approval_id]
  /show [all|thinking|tools|none]
  /agent [list|switch|create|model]   /bots   /bot [info|list|set <id|name>]
  /model [name]   /model info|list [provider]|set <name>|clear|default [name]
  /channel-mode <off|mention|free>   /channel-policy <open|allowlist|disabled>
  /rag [on|off]   /ralph [info|on|off|set n]   /mcp list
  /mcp add <name> <json>
  /mcp toggle <name> /mcp remove <name> /mcp reconnect <name>
  /usage [summary|daily|monthly|model [daily|monthly] [agentId]]
  /export [sessionId]   /sessions   /audit [sessionId]
  /schedule add "<cron>" <prompt> | at "<ISO time>" <prompt> | every <ms> <prompt>
  /info   /compact   /clear   /reset [yes|no]   /stop   /exit`);
}

function printOnboardingUsage(): void {
  console.log(`Usage: hybridclaw onboarding

Runs the HybridClaw onboarding flow:
  1) trust-model acceptance
  2) auth provider selection
  3) HybridAI API key setup, OpenAI Codex OAuth login, or OpenRouter API key setup
  4) default model/bot persistence`);
}

function printLocalUsage(): void {
  console.log(`Usage: hybridclaw local <command> (deprecated)

Commands:
  hybridclaw local status
  hybridclaw local configure <ollama|lmstudio|vllm> <model-id> [--base-url <url>] [--api-key <key>] [--no-default]

Use Instead:
  hybridclaw auth login local <ollama|lmstudio|vllm> <model-id> ...
  hybridclaw auth status local
  hybridclaw auth logout local

Examples:
  hybridclaw local configure lmstudio qwen/qwen3.5-9b --base-url http://127.0.0.1:1234
  hybridclaw local configure ollama llama3.2
  hybridclaw local configure vllm mistralai/Mistral-7B-Instruct-v0.3 --base-url http://127.0.0.1:8000 --api-key secret

Notes:
  - \`hybridclaw local ...\` is deprecated and will be removed in a future release.
  - LM Studio and vLLM URLs are normalized to include \`/v1\`.
  - Ollama URLs are normalized to omit \`/v1\`.
  - By default, \`configure\` also sets \`hybridai.defaultModel\` to the chosen local model.
    Use \`--no-default\` to leave the global default model unchanged.`);
}

function printAuthUsage(): void {
  console.log(`Usage: hybridclaw auth <command> [provider] [options]

Commands:
  hybridclaw auth login
  hybridclaw auth login <hybridai|codex|openrouter|local> ...
  hybridclaw auth status <hybridai|codex|openrouter|local>
  hybridclaw auth logout <hybridai|codex|openrouter|local>
  hybridclaw auth whatsapp reset

Examples:
  hybridclaw auth login
  hybridclaw auth login hybridai --browser
  hybridclaw auth login codex --import
  hybridclaw auth login openrouter anthropic/claude-sonnet-4 --api-key sk-or-...
  hybridclaw auth login local ollama llama3.2
  hybridclaw auth whatsapp reset
  hybridclaw auth status openrouter
  hybridclaw auth logout codex

Notes:
  - \`auth login\` without a provider runs the normal interactive onboarding flow.
  - \`local logout\` disables configured local backends and clears any saved vLLM API key.
  - \`auth whatsapp reset\` clears linked WhatsApp Web auth so you can re-pair cleanly.
  - \`auth login openrouter\` prompts for the API key when \`--api-key\` and \`OPENROUTER_API_KEY\` are both absent.
  - The older \`hybridclaw hybridai ...\`, \`hybridclaw codex ...\`, and \`hybridclaw local ...\` aliases are deprecated.`);
}

function printChannelsUsage(): void {
  console.log(`Usage: hybridclaw channels <channel> <command>

Commands:
  hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]
  hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...
  hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--imap-port <port>] [--smtp-host <host>] [--smtp-port <port>] [--folder <name>]... [--allow-from <email|*@domain|*>]... [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>]

Notes:
  - Discord setup stores a bot token only when \`--token\` is provided.
  - Discord setup configures command-only mode and keeps guild access restricted by default.
  - WhatsApp setup starts a temporary pairing session and prints the QR code here when needed.
  - Use \`--reset\` to wipe stale WhatsApp auth files and force a fresh QR.
  - \`hybridclaw auth whatsapp reset\` clears linked WhatsApp auth without starting a new pairing session.
  - Without \`--allow-from\`, setup configures WhatsApp for self-chat only.
  - With one or more \`--allow-from\` values, setup enables only those DMs.
  - Groups stay disabled by default.
  - Email setup saves \`EMAIL_PASSWORD\` only when \`--password\` is provided or pasted interactively.
  - Email inbound is explicit-opt-in: when email \`allowFrom\` is empty, inbound email is ignored.
  - Discord activates automatically when \`DISCORD_TOKEN\` is configured.
  - Email activates automatically when \`email.enabled=true\` and \`EMAIL_PASSWORD\` is configured.
  - WhatsApp activates automatically once linked auth exists.`);
}

function printWhatsAppUsage(): void {
  console.log(`Usage:
  hybridclaw auth whatsapp reset
  hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...

Notes:
  - Only one running HybridClaw process may own the WhatsApp auth state at a time.
  - Use \`auth whatsapp reset\` to clear stale linked-device auth before re-pairing.
  - Use \`channels whatsapp setup\` to configure policy and open a fresh QR pairing session.`);
}

function printCodexUsage(): void {
  console.log(`Usage: hybridclaw codex <command> (deprecated)

Commands:
  hybridclaw codex login
  hybridclaw codex login --device-code
  hybridclaw codex login --browser
  hybridclaw codex login --import
  hybridclaw codex logout
  hybridclaw codex status

Use Instead:
  hybridclaw auth login codex ...
  hybridclaw auth logout codex
  hybridclaw auth status codex

Notes:
  - \`hybridclaw codex ...\` is deprecated and will be removed in a future release.`);
}

function printHybridAIUsage(): void {
  console.log(`Usage: hybridclaw hybridai <command> (deprecated)

Commands:
  hybridclaw hybridai login
  hybridclaw hybridai login --device-code
  hybridclaw hybridai login --browser
  hybridclaw hybridai login --import
  hybridclaw hybridai logout
  hybridclaw hybridai status

Use Instead:
  hybridclaw auth login hybridai ...
  hybridclaw auth logout hybridai
  hybridclaw auth status hybridai

Notes:
  - \`hybridclaw hybridai ...\` is deprecated and will be removed in a future release.`);
}

function printOpenRouterUsage(): void {
  console.log(`Usage:
  hybridclaw auth login openrouter [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
  hybridclaw auth status openrouter
  hybridclaw auth logout openrouter

Notes:
  - Model IDs use the \`openrouter/\` prefix in HybridClaw, for example \`openrouter/anthropic/claude-sonnet-4\`.
  - If \`--api-key\` is omitted and \`OPENROUTER_API_KEY\` is unset, HybridClaw prompts you to paste the API key.
  - \`auth login openrouter\` stores \`OPENROUTER_API_KEY\`, enables the provider, and can set the global default model.
  - \`auth logout openrouter\` clears the stored API key but leaves runtime config unchanged.`);
}

function printAuditUsage(): void {
  console.log(`Usage: hybridclaw audit <command>

Commands:
  recent [n]                         Show recent structured audit entries
  recent session <sessionId> [n]     Show recent events for one session
  search <query> [n]                 Search structured audit events
  approvals [n] [--denied]           Show approval decisions
  verify <sessionId>                 Verify wire hash chain integrity
  instructions [--sync] [--approve]  Verify or restore runtime instruction files`);
}

function printSkillUsage(): void {
  console.log(`Usage: hybridclaw skill <command>

Commands:
  hybridclaw skill list
  hybridclaw skill install <skill-name> [install-id]

Notes:
  - \`list\` shows declared install options from skill frontmatter.
  - \`install\` runs one declared installer (brew, uv, npm, go, download).`);
}

function printHelpUsage(): void {
  console.log(`Usage: hybridclaw help <topic>

Topics:
  auth        Help for unified provider login/logout/status
  gateway     Help for gateway lifecycle and passthrough commands
  tui         Help for terminal client
  onboarding  Help for onboarding flow
  channels    Help for channel setup helpers
  local       Help for deprecated local provider alias
  hybridai    Help for deprecated HybridAI provider alias
  codex       Help for deprecated Codex provider alias
  openrouter  Help for OpenRouter setup/status/logout commands
  whatsapp    Help for WhatsApp setup/reset commands
  skill       Help for skill installer commands
  update      Help for checking/applying CLI updates
  audit       Help for audit commands
  help        This help`);
}

function printDeprecatedProviderAliasWarning(
  provider: 'hybridai' | 'codex' | 'local',
  args: string[],
): void {
  const sub = (args[0] || '').trim().toLowerCase();
  let replacement = '';

  if (provider === 'local') {
    replacement =
      sub === 'status'
        ? 'hybridclaw auth status local'
        : sub === 'help' || sub === '--help' || sub === '-h'
          ? 'hybridclaw help local'
          : 'hybridclaw auth login local ...';
  } else {
    replacement =
      sub === 'status'
        ? `hybridclaw auth status ${provider}`
        : sub === 'logout'
          ? `hybridclaw auth logout ${provider}`
          : sub === 'help' || sub === '--help' || sub === '-h'
            ? `hybridclaw help ${provider}`
            : `hybridclaw auth login ${provider} ...`;
  }

  console.warn(
    `[deprecated] \`hybridclaw ${provider} ...\` is deprecated and will be removed in a future release. Use \`${replacement}\` instead.`,
  );
}

function isHelpRequest(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0]?.toLowerCase();
  return first === 'help' || first === '--help' || first === '-h';
}

function printHelpTopic(topic: string): boolean {
  switch (topic.trim().toLowerCase()) {
    case 'auth':
      printAuthUsage();
      return true;
    case 'gateway':
      printGatewayUsage();
      return true;
    case 'tui':
      printTuiUsage();
      return true;
    case 'onboarding':
      printOnboardingUsage();
      return true;
    case 'channels':
      printChannelsUsage();
      return true;
    case 'local':
      printLocalUsage();
      return true;
    case 'hybridai':
      printHybridAIUsage();
      return true;
    case 'codex':
      printCodexUsage();
      return true;
    case 'openrouter':
      printOpenRouterUsage();
      return true;
    case 'whatsapp':
      printWhatsAppUsage();
      return true;
    case 'skill':
      printSkillUsage();
      return true;
    case 'update':
      printUpdateUsage();
      return true;
    case 'audit':
      printAuditUsage();
      return true;
    case 'help':
      printHelpUsage();
      return true;
    default:
      return false;
  }
}

interface GatewayPidState {
  pid: number;
  startedAt: string;
  cwd: string;
  command: string[];
}

const GATEWAY_RUN_DIR = path.join(DATA_DIR, 'gateway');
const GATEWAY_PID_PATH = path.join(GATEWAY_RUN_DIR, 'gateway.pid.json');
const GATEWAY_LOG_PATH = path.join(GATEWAY_RUN_DIR, 'gateway.log');
const GATEWAY_LOG_FILE_ENV = 'HYBRIDCLAW_GATEWAY_LOG_FILE';
const GATEWAY_STDIO_TO_LOG_ENV = 'HYBRIDCLAW_GATEWAY_STDIO_TO_LOG';

function ensureGatewayRunDir(): void {
  fs.mkdirSync(GATEWAY_RUN_DIR, { recursive: true });
}

function writeGatewayPid(state: GatewayPidState): void {
  ensureGatewayRunDir();
  const tmp = `${GATEWAY_PID_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, GATEWAY_PID_PATH);
}

function removeGatewayPidFile(): void {
  if (fs.existsSync(GATEWAY_PID_PATH)) fs.unlinkSync(GATEWAY_PID_PATH);
}

function readGatewayPid(): GatewayPidState | null {
  try {
    const raw = fs.readFileSync(GATEWAY_PID_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GatewayPidState>;
    if (
      !parsed ||
      typeof parsed.pid !== 'number' ||
      !Number.isFinite(parsed.pid)
    )
      return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      command: Array.isArray(parsed.command)
        ? parsed.command.map((item) => String(item))
        : [],
    };
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGatewayReachable(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGatewayReachable()) return true;
    await sleep(250);
  }
  return false;
}

async function waitForGatewayUnreachable(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isGatewayReachable())) return true;
    await sleep(250);
  }
  return false;
}

async function requestUnmanagedGatewayShutdown(): Promise<void> {
  const { gatewayShutdown } = await import('./gateway/gateway-client.js');
  await gatewayShutdown();
}

function parseGatewayBaseUrl(): URL | null {
  try {
    return new URL(GATEWAY_BASE_URL);
  } catch {
    return null;
  }
}

function isLocalGatewayHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1'
  );
}

function resolveGatewayListenPort(url: URL): number {
  if (url.port) {
    const parsed = Number.parseInt(url.port, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return url.protocol === 'https:' ? 443 : 80;
}

function findGatewayPidByPort(): number | null {
  const parsed = parseGatewayBaseUrl();
  if (!parsed || !isLocalGatewayHost(parsed.hostname)) return null;
  const port = resolveGatewayListenPort(parsed);

  const result = spawnSync(
    'lsof',
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
    {
      encoding: 'utf-8',
    },
  );
  if (result.error) return null;
  const output = (result.stdout || '').trim();
  if (!output) return null;

  const firstPid = output
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .find((pid) => Number.isFinite(pid) && pid > 0);
  return firstPid && Number.isFinite(firstPid) ? firstPid : null;
}

function adoptGatewayPid(pid: number, source: string): boolean {
  if (!isPidRunning(pid)) return false;
  writeGatewayPid({
    pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    command: [`(adopted-from-${source})`],
  });
  return true;
}

async function adoptReachableGatewayIfPossible(): Promise<boolean> {
  const { gatewayStatus } = await import('./gateway/gateway-client.js');
  const status = await gatewayStatus();
  const pid =
    typeof status.pid === 'number' && Number.isFinite(status.pid)
      ? Math.floor(status.pid)
      : 0;
  if (pid > 0 && adoptGatewayPid(pid, 'api-status')) return true;
  const fallbackPid = findGatewayPidByPort();
  if (fallbackPid && adoptGatewayPid(fallbackPid, 'lsof-port-probe'))
    return true;
  return false;
}

async function runGatewayForeground(
  commandName: string,
  sandboxMode: SandboxModeOverride | null = null,
  debug = false,
): Promise<void> {
  await ensureRuntimeCredentials({ commandName });
  if (sandboxMode) {
    setSandboxModeOverride(sandboxMode);
  }
  if (debug) {
    process.env.HYBRIDCLAW_FORCE_LOG_LEVEL = 'debug';
    const { forceLoggerLevel } = await import('./logger.js');
    forceLoggerLevel('debug');
    console.log(`${commandName}: forcing gateway log level to debug.`);
  }
  ensureGatewayRunDir();
  if (process.env[GATEWAY_STDIO_TO_LOG_ENV] === '1') {
    delete process.env[GATEWAY_LOG_FILE_ENV];
  } else {
    process.env[GATEWAY_LOG_FILE_ENV] = GATEWAY_LOG_PATH;
  }
  await ensureRuntimeContainer(commandName, true, sandboxMode);
  await import('./gateway/gateway.js');
}

async function startGatewayBackend(
  commandName: string,
  waitForHealthy = false,
  sandboxMode: SandboxModeOverride | null = null,
  debug = false,
): Promise<void> {
  if (await isGatewayReachable()) {
    const existing = readGatewayPid();
    if (existing && isPidRunning(existing.pid)) {
      console.log(
        `Gateway already running in backend mode (pid ${existing.pid}).`,
      );
    } else {
      let adopted = false;
      try {
        adopted = await adoptReachableGatewayIfPossible();
      } catch {
        adopted = false;
      }
      if (adopted) {
        const adoptedState = readGatewayPid();
        console.log(
          `Gateway already reachable at ${GATEWAY_BASE_URL}; adopted pid ${adoptedState?.pid || '(unknown)'}.`,
        );
      } else {
        console.log(
          `Gateway already reachable at ${GATEWAY_BASE_URL} (unmanaged by CLI PID file).`,
        );
      }
    }
    return;
  }

  const existing = readGatewayPid();
  if (existing && isPidRunning(existing.pid)) {
    if (waitForHealthy && !(await isGatewayReachable())) {
      const healthy = await waitForGatewayReachable(15_000);
      if (!healthy) {
        throw new Error(
          `Gateway process ${existing.pid} exists but did not become reachable at ${GATEWAY_BASE_URL}.` +
            ` Check logs: ${GATEWAY_LOG_PATH}`,
        );
      }
    }
    console.log(
      `Gateway already running in backend mode (pid ${existing.pid}).`,
    );
    return;
  }
  if (existing && !isPidRunning(existing.pid)) {
    removeGatewayPidFile();
  }

  await ensureRuntimeCredentials({ commandName });
  await ensureRuntimeContainer(commandName, true, sandboxMode);

  ensureGatewayRunDir();
  const out = fs.openSync(GATEWAY_LOG_PATH, 'a');
  const err = fs.openSync(GATEWAY_LOG_PATH, 'a');
  const cliEntry = process.argv[1];
  const childArgs = [
    cliEntry,
    'gateway',
    'start',
    '--foreground',
    ...(debug ? ['--debug'] : []),
    ...(sandboxMode ? [`--sandbox=${sandboxMode}`] : []),
  ];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: process.cwd(),
    env: {
      ...process.env,
      [GATEWAY_STDIO_TO_LOG_ENV]: '1',
    },
  });
  child.unref();

  if (!child.pid) {
    throw new Error('Failed to spawn gateway backend process.');
  }

  writeGatewayPid({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    command: childArgs,
  });

  if (waitForHealthy) {
    const healthy = await waitForGatewayReachable(20_000);
    if (!healthy) {
      throw new Error(
        `Gateway backend started (pid ${child.pid}) but not reachable at ${GATEWAY_BASE_URL}.` +
          ` Check logs: ${GATEWAY_LOG_PATH}`,
      );
    }
  }

  console.log(`Gateway started in backend mode (pid ${child.pid}).`);
  console.log(`Logs: ${GATEWAY_LOG_PATH}`);
}

function isShutdownEndpointMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found/i.test(message) || /404/.test(message);
}

async function stopManagedGatewayByPid(state: GatewayPidState): Promise<void> {
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    removeGatewayPidFile();
    throw new Error(
      `Failed to stop gateway pid ${state.pid}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isPidRunning(state.pid)) {
      removeGatewayPidFile();
      console.log(`Gateway stopped (pid ${state.pid}).`);
      return;
    }
    await sleep(200);
  }

  try {
    process.kill(state.pid, 'SIGKILL');
  } catch {
    // best effort
  }

  await sleep(200);
  removeGatewayPidFile();
  console.log(`Gateway stop timed out; sent SIGKILL to pid ${state.pid}.`);
}

async function stopUnmanagedGatewayGracefully(
  mode: 'stop' | 'restart',
): Promise<void> {
  const suffix = mode === 'restart' ? ' before restart' : '';
  console.log('Gateway is reachable but unmanaged by CLI PID file.');
  console.log(`Requesting graceful shutdown over API${suffix}...`);

  try {
    await requestUnmanagedGatewayShutdown();
    const stopped = await waitForGatewayUnreachable(10_000);
    if (!stopped) {
      throw new Error(
        `Gateway remained reachable at ${GATEWAY_BASE_URL} after shutdown request.` +
          ' Stop it from its owning process or use your system process manager.',
      );
    }
    console.log('Unmanaged gateway stopped via API request.');
    return;
  } catch (err) {
    if (!isShutdownEndpointMissing(err)) throw err;
  }

  const discoveredPid = findGatewayPidByPort();
  if (
    discoveredPid &&
    discoveredPid !== process.pid &&
    adoptGatewayPid(discoveredPid, 'lsof-port-probe')
  ) {
    const adoptedState = readGatewayPid();
    if (adoptedState && isPidRunning(adoptedState.pid)) {
      console.log(
        `Shutdown API unavailable; stopping gateway pid ${adoptedState.pid} via local signal.`,
      );
      await stopManagedGatewayByPid(adoptedState);
      return;
    }
  }

  throw new Error(
    `Gateway shutdown endpoint is unavailable at ${GATEWAY_BASE_URL} and PID ownership could not be recovered.` +
      ' Stop the process manually once, then retry.',
  );
}

async function stopGatewayBackend(): Promise<void> {
  const state = readGatewayPid();
  if (!state) {
    if (await isGatewayReachable()) {
      await stopUnmanagedGatewayGracefully('stop');
      return;
    }
    console.log('Gateway is not running (no PID file).');
    return;
  }

  if (!isPidRunning(state.pid)) {
    removeGatewayPidFile();
    if (await isGatewayReachable()) {
      console.log(
        `Removed stale gateway PID file (pid ${state.pid} not running).`,
      );
      await stopUnmanagedGatewayGracefully('stop');
      return;
    }
    console.log(
      `Removed stale gateway PID file (pid ${state.pid} not running).`,
    );
    return;
  }

  await stopManagedGatewayByPid(state);
}

async function printGatewayLifecycleStatus(): Promise<void> {
  const state = readGatewayPid();
  const runningByPid = Boolean(state && isPidRunning(state.pid));
  const reachable = await isGatewayReachable();

  if (state && runningByPid) {
    console.log(`PID file: running (pid ${state.pid})`);
  } else if (state) {
    console.log(`PID file: stale (pid ${state.pid})`);
  } else {
    console.log('PID file: not found');
  }
  console.log(
    `Gateway API reachable: ${reachable ? 'yes' : 'no'} (${GATEWAY_BASE_URL})`,
  );

  if (reachable) {
    try {
      const { gatewayStatus } = await import('./gateway/gateway-client.js');
      const status = await gatewayStatus();
      console.log(
        `Uptime: ${status.uptime}s | Sessions: ${status.sessions} | Sandbox: ${status.sandbox?.mode || 'container'} (${status.sandbox?.activeSessions ?? status.activeContainers} active)`,
      );
    } catch (err) {
      console.log(
        `Gateway status fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function runGatewayApiCommand(args: string[]): Promise<void> {
  const { gatewayCommand, renderGatewayCommand } = await import(
    './gateway/gateway-client.js'
  );
  const result = await gatewayCommand({
    sessionId: 'cli:gateway',
    guildId: null,
    channelId: 'cli',
    args,
  });

  const rendered = renderGatewayCommand(result).trim();
  if (rendered) console.log(rendered);
  if (result.kind === 'error') process.exitCode = 1;
}

async function handleGatewayCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0) {
    await startGatewayBackend('hybridclaw gateway');
    return;
  }

  const sub = normalized[0].toLowerCase();
  const subArgs = normalized.slice(1);
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printGatewayUsage();
    return;
  }

  const unsupportedLifecycleFlag =
    findUnsupportedGatewayLifecycleFlag(normalized);
  if (unsupportedLifecycleFlag) {
    console.error(
      unsupportedLifecycleFlag === 'sandbox'
        ? '`--sandbox` is only supported with `hybridclaw gateway start` and `hybridclaw gateway restart`.'
        : unsupportedLifecycleFlag === 'foreground'
          ? '`--foreground` is only supported with `hybridclaw gateway start` and `hybridclaw gateway restart`.'
          : '`--debug` is only supported with `hybridclaw gateway start` and `hybridclaw gateway restart`.',
    );
    process.exitCode = 1;
    return;
  }

  if (sub === 'start') {
    const flags = parseGatewayFlags(subArgs);
    if (flags.help) {
      printGatewayUsage();
      return;
    }
    if (flags.foreground) {
      await runGatewayForeground(
        'hybridclaw gateway start --foreground',
        flags.sandboxMode,
        flags.debug,
      );
      return;
    }
    await startGatewayBackend(
      'hybridclaw gateway start',
      false,
      flags.sandboxMode,
      flags.debug,
    );
    return;
  }

  if (sub === 'restart') {
    const flags = parseGatewayFlags(subArgs);
    if (flags.help) {
      printGatewayUsage();
      return;
    }
    await stopGatewayBackend();

    if (flags.foreground) {
      await runGatewayForeground(
        'hybridclaw gateway restart --foreground',
        flags.sandboxMode,
        flags.debug,
      );
      return;
    }
    await startGatewayBackend(
      'hybridclaw gateway restart',
      false,
      flags.sandboxMode,
      flags.debug,
    );
    return;
  }

  if (sub === 'stop') {
    await stopGatewayBackend();
    return;
  }

  if (sub === 'status' && normalized.length === 1) {
    await printGatewayLifecycleStatus();
    return;
  }

  if (sub === 'audit') {
    console.error('Use top-level audit commands: `hybridclaw audit ...`');
    process.exitCode = 1;
    return;
  }

  await runGatewayApiCommand(normalized);
}

function parseCodexLoginMethod(
  args: string[],
): 'auto' | 'device-code' | 'browser-pkce' | 'codex-cli-import' {
  const flags = new Set(args.map((arg) => arg.trim().toLowerCase()));
  const requested = [
    flags.has('--device-code') ? 'device-code' : null,
    flags.has('--browser') ? 'browser-pkce' : null,
    flags.has('--import') ? 'codex-cli-import' : null,
  ].filter(Boolean) as Array<
    'device-code' | 'browser-pkce' | 'codex-cli-import'
  >;

  if (requested.length > 1) {
    throw new Error(
      'Use only one of `--device-code`, `--browser`, or `--import`.',
    );
  }
  return requested[0] || 'auto';
}

function parseHybridAILoginMethod(
  args: string[],
): 'auto' | 'device-code' | 'browser' | 'import' {
  const flags = new Set(args.map((arg) => arg.trim().toLowerCase()));
  const requested = [
    flags.has('--device-code') ? 'device-code' : null,
    flags.has('--browser') ? 'browser' : null,
    flags.has('--import') ? 'import' : null,
  ].filter(Boolean) as Array<'device-code' | 'browser' | 'import'>;

  if (requested.length > 1) {
    throw new Error(
      'Use only one of `--device-code`, `--browser`, or `--import`.',
    );
  }
  return requested[0] || 'auto';
}

interface ParsedOpenRouterLoginArgs {
  modelId?: string;
  baseUrl?: string;
  apiKey?: string;
  setDefault: boolean;
}

function parseOpenRouterLoginArgs(args: string[]): ParsedOpenRouterLoginArgs {
  const positional: string[] = [];
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let setDefault = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--no-default') {
      setDefault = false;
      continue;
    }
    if (arg === '--set-default') {
      setDefault = true;
      continue;
    }
    if (arg === '--base-url') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--base-url`.');
      baseUrl = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
      continue;
    }
    if (arg === '--api-key') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--api-key`.');
      apiKey = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--api-key=')) {
      apiKey = arg.slice('--api-key='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  return {
    modelId: positional.length > 0 ? positional.join(' ') : undefined,
    baseUrl,
    apiKey,
    setDefault,
  };
}

function normalizeOpenRouterModelId(rawModelId: string): string {
  const trimmed = rawModelId.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('openrouter/')) {
    return trimmed;
  }
  return `openrouter/${trimmed}`;
}

function normalizeOpenRouterBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/g, '');
  if (!trimmed) return 'https://openrouter.ai/api/v1';
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

async function promptForOpenRouterApiKey(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Missing OpenRouter API key. Pass `--api-key <key>`, set `OPENROUTER_API_KEY`, or run this command in an interactive terminal to paste it.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return (await rl.question('Paste OpenRouter API key: ')).trim();
  } finally {
    rl.close();
  }
}

async function resolveOpenRouterApiKey(
  explicitApiKey: string | undefined,
): Promise<string> {
  const configuredApiKey =
    explicitApiKey?.trim() || process.env.OPENROUTER_API_KEY?.trim() || '';
  if (configuredApiKey) return configuredApiKey;

  const promptedApiKey = await promptForOpenRouterApiKey();
  if (promptedApiKey) return promptedApiKey;

  throw new Error(
    'OpenRouter API key cannot be empty. Pass `--api-key <key>`, set `OPENROUTER_API_KEY`, or paste it when prompted.',
  );
}

async function configureOpenRouter(args: string[]): Promise<void> {
  ensureRuntimeConfigFile();
  const parsed = parseOpenRouterLoginArgs(args);
  const currentConfig = getRuntimeConfig();
  const configuredModel =
    parsed.modelId ||
    currentConfig.openrouter.models[0] ||
    'openrouter/anthropic/claude-sonnet-4';
  const fullModelName = normalizeOpenRouterModelId(configuredModel);
  if (!fullModelName) {
    throw new Error('OpenRouter model ID cannot be empty.');
  }

  const apiKey = await resolveOpenRouterApiKey(parsed.apiKey);

  const normalizedBaseUrl = normalizeOpenRouterBaseUrl(
    parsed.baseUrl || currentConfig.openrouter.baseUrl,
  );
  const secretsPath = saveRuntimeSecrets({ OPENROUTER_API_KEY: apiKey });
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.openrouter.enabled = true;
    draft.openrouter.baseUrl = normalizedBaseUrl;
    draft.openrouter.models = Array.from(
      new Set([fullModelName, ...draft.openrouter.models]),
    );
    if (parsed.setDefault) {
      draft.hybridai.defaultModel = fullModelName;
    }
  });

  process.env.OPENROUTER_API_KEY = apiKey;
  console.log(`Saved OpenRouter credentials to ${secretsPath}.`);
  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Provider: openrouter`);
  console.log(`Base URL: ${nextConfig.openrouter.baseUrl}`);
  console.log(`Configured model: ${fullModelName}`);
  if (parsed.setDefault) {
    console.log(`Default model: ${fullModelName}`);
  } else {
    console.log(`Default model unchanged: ${nextConfig.hybridai.defaultModel}`);
  }
  console.log('Next:');
  console.log('  hybridclaw gateway restart --foreground');
  console.log('  hybridclaw gateway status');
  console.log('  hybridclaw tui');
  console.log(`  /model set ${fullModelName}`);
}

type UnifiedProvider = 'hybridai' | 'codex' | 'openrouter' | 'local';

function normalizeUnifiedProvider(
  rawProvider: string | undefined,
): UnifiedProvider | null {
  const normalized = String(rawProvider || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (
    normalized === 'hybridai' ||
    normalized === 'hybrid-ai' ||
    normalized === 'hybrid'
  ) {
    return 'hybridai';
  }
  if (normalized === 'codex' || normalized === 'openai-codex') {
    return 'codex';
  }
  if (normalized === 'openrouter' || normalized === 'or') {
    return 'openrouter';
  }
  if (normalized === 'local') {
    return 'local';
  }
  return null;
}

function normalizeArgs(args: string[]): string[] {
  return args.map((arg) => arg.trim()).filter(Boolean);
}

function parseUnifiedProviderArgs(args: string[]): {
  provider: UnifiedProvider | null;
  remaining: string[];
} {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0) {
    return {
      provider: null,
      remaining: [],
    };
  }

  const first = normalized[0] || '';
  if (first === '--provider') {
    const rawProvider = normalized[1];
    if (!rawProvider) {
      throw new Error('Missing value for `--provider`.');
    }
    const provider = normalizeUnifiedProvider(rawProvider);
    if (!provider) {
      throw new Error(
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`openrouter\`, or \`local\`.`,
      );
    }
    return {
      provider,
      remaining: normalized.slice(2),
    };
  }

  if (first.startsWith('--provider=')) {
    const rawProvider = first.slice('--provider='.length);
    const provider = normalizeUnifiedProvider(rawProvider);
    if (!provider) {
      throw new Error(
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`openrouter\`, or \`local\`.`,
      );
    }
    return {
      provider,
      remaining: normalized.slice(1),
    };
  }

  return {
    provider: normalizeUnifiedProvider(first),
    remaining:
      normalizeUnifiedProvider(first) == null
        ? normalized
        : normalized.slice(1),
  };
}

function readStoredRuntimeSecret(
  secretKey: 'OPENROUTER_API_KEY',
): string | null {
  const filePath = runtimeSecretsPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[secretKey];
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized || null;
  } catch {
    return null;
  }
}

function maskSecret(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}…${normalized.slice(-1)}`;
  }
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

function isLocalProviderModel(modelName: string): boolean {
  return /^(ollama|lmstudio|vllm)\//i.test(modelName.trim());
}

function printOpenRouterStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const storedApiKey = readStoredRuntimeSecret('OPENROUTER_API_KEY');
  const envApiKey = process.env.OPENROUTER_API_KEY?.trim() || '';
  const source = envApiKey
    ? storedApiKey && envApiKey === storedApiKey
      ? 'runtime-secrets'
      : 'env'
    : storedApiKey
      ? 'runtime-secrets'
      : null;
  const apiKey = envApiKey || storedApiKey || '';

  console.log(`Path: ${runtimeSecretsPath()}`);
  console.log(`Authenticated: ${apiKey ? 'yes' : 'no'}`);
  if (source) {
    console.log(`Source: ${source}`);
  }
  if (apiKey) {
    console.log(`API key: ${maskSecret(apiKey)}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config.openrouter.enabled ? 'yes' : 'no'}`);
  console.log(`Base URL: ${config.openrouter.baseUrl}`);
  console.log(`Default model: ${config.hybridai.defaultModel}`);
  console.log(
    `Models: ${config.openrouter.models.length > 0 ? config.openrouter.models.join(', ') : '(none configured)'}`,
  );
}

function clearOpenRouterCredentials(): void {
  const filePath = saveRuntimeSecrets({ OPENROUTER_API_KEY: null });
  delete process.env.OPENROUTER_API_KEY;
  console.log(`Cleared OpenRouter credentials in ${filePath}.`);
  console.log(
    'If OPENROUTER_API_KEY is still exported in your shell, unset it separately.',
  );
}

function clearLocalBackends(): void {
  ensureRuntimeConfigFile();
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.local.backends.ollama.enabled = false;
    draft.local.backends.lmstudio.enabled = false;
    draft.local.backends.vllm.enabled = false;
    draft.local.backends.vllm.apiKey = '';
  });

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log('Disabled local backends: ollama, lmstudio, vllm.');
  if (isLocalProviderModel(nextConfig.hybridai.defaultModel)) {
    console.log(`Default model unchanged: ${nextConfig.hybridai.defaultModel}`);
    console.log(
      'Hint: default model still points at a local backend. Configure another provider before starting new sessions.',
    );
  } else {
    console.log(`Default model: ${nextConfig.hybridai.defaultModel}`);
  }
}

function printUnifiedProviderUsage(provider: UnifiedProvider): void {
  if (provider === 'hybridai') {
    printHybridAIUsage();
    return;
  }
  if (provider === 'codex') {
    printCodexUsage();
    return;
  }
  if (provider === 'openrouter') {
    printOpenRouterUsage();
    return;
  }
  printLocalUsage();
}

function isLocalBackendType(value: string): value is LocalBackendType {
  return value === 'ollama' || value === 'lmstudio' || value === 'vllm';
}

function normalizeLocalModelId(
  backend: LocalBackendType,
  rawModelId: string,
): string {
  const trimmed = rawModelId.trim();
  const ownPrefix = `${backend}/`;
  if (trimmed.toLowerCase().startsWith(ownPrefix)) {
    return trimmed.slice(ownPrefix.length).trim();
  }
  if (/^(ollama|lmstudio|vllm)\//i.test(trimmed)) {
    throw new Error(
      `Model "${trimmed}" already includes a different local provider prefix.`,
    );
  }
  return trimmed;
}

function normalizeLocalBaseUrl(
  backend: LocalBackendType,
  rawBaseUrl: string,
): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/g, '');
  if (!trimmed) {
    if (backend === 'ollama') return 'http://127.0.0.1:11434';
    if (backend === 'lmstudio') return 'http://127.0.0.1:1234/v1';
    return 'http://127.0.0.1:8000/v1';
  }
  if (backend === 'ollama') {
    return trimmed.replace(/\/v1$/i, '');
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

interface ParsedLocalConfigureArgs {
  backend: LocalBackendType;
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  setDefault: boolean;
}

function parseLocalConfigureArgs(args: string[]): ParsedLocalConfigureArgs {
  const positional: string[] = [];
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let setDefault = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--no-default') {
      setDefault = false;
      continue;
    }
    if (arg === '--set-default') {
      setDefault = true;
      continue;
    }
    if (arg === '--base-url') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--base-url`.');
      baseUrl = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
      continue;
    }
    if (arg === '--api-key') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--api-key`.');
      apiKey = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--api-key=')) {
      apiKey = arg.slice('--api-key='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length < 2) {
    throw new Error(
      'Usage: `hybridclaw local configure <ollama|lmstudio|vllm> <model-id> [--base-url <url>] [--api-key <key>] [--no-default]`',
    );
  }

  const backendRaw = (positional[0] || '').trim().toLowerCase();
  if (!isLocalBackendType(backendRaw)) {
    throw new Error(
      `Unknown local backend "${positional[0]}". Use \`ollama\`, \`lmstudio\`, or \`vllm\`.`,
    );
  }

  if (backendRaw !== 'vllm' && apiKey !== undefined) {
    throw new Error('`--api-key` is only supported for the `vllm` backend.');
  }

  const modelId = normalizeLocalModelId(
    backendRaw,
    positional.slice(1).join(' '),
  );
  if (!modelId) {
    throw new Error('Model ID cannot be empty.');
  }

  return {
    backend: backendRaw,
    modelId,
    baseUrl,
    apiKey,
    setDefault,
  };
}

function printLocalStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Default model: ${config.hybridai.defaultModel}`);
  for (const backend of ['ollama', 'lmstudio', 'vllm'] as const) {
    const settings = config.local.backends[backend];
    console.log(
      `${backend}: ${settings.enabled ? 'enabled' : 'disabled'} (${settings.baseUrl})`,
    );
    if (backend === 'vllm') {
      console.log(
        `vllm api key: ${settings.apiKey ? 'configured' : 'not set'}`,
      );
    }
  }
}

function configureLocalBackend(args: string[]): void {
  ensureRuntimeConfigFile();
  const parsed = parseLocalConfigureArgs(args);
  const currentConfig = getRuntimeConfig();
  const currentBackend = currentConfig.local.backends[parsed.backend];
  const normalizedBaseUrl = normalizeLocalBaseUrl(
    parsed.backend,
    parsed.baseUrl || currentBackend.baseUrl,
  );
  const fullModelName = `${parsed.backend}/${parsed.modelId}`;
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.local.backends[parsed.backend].enabled = true;
    draft.local.backends[parsed.backend].baseUrl = normalizedBaseUrl;
    if (parsed.backend === 'vllm' && parsed.apiKey !== undefined) {
      draft.local.backends.vllm.apiKey = parsed.apiKey;
    }
    if (parsed.setDefault) {
      draft.hybridai.defaultModel = fullModelName;
    }
  });

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Backend: ${parsed.backend}`);
  console.log(`Base URL: ${nextConfig.local.backends[parsed.backend].baseUrl}`);
  console.log(`Configured model: ${fullModelName}`);
  if (parsed.backend === 'vllm' && parsed.apiKey !== undefined) {
    console.log('vllm api key: configured');
  }
  if (parsed.setDefault) {
    console.log(`Default model: ${fullModelName}`);
  } else {
    console.log(`Default model unchanged: ${nextConfig.hybridai.defaultModel}`);
  }
  console.log('Next:');
  console.log('  hybridclaw gateway restart --foreground --sandbox=host');
  console.log('  hybridclaw gateway status');
  console.log('  hybridclaw tui');
  console.log(`  /model set ${fullModelName}`);
}

async function handleLocalCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printLocalUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'status') {
    printLocalStatus();
    return;
  }
  if (sub === 'configure') {
    configureLocalBackend(normalized.slice(1));
    return;
  }

  throw new Error(`Unknown local subcommand: ${sub}`);
}

async function handleAuthLoginCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0) {
    await ensureRuntimeCredentials({
      commandName: 'hybridclaw auth login',
    });
    return;
  }
  if (isHelpRequest(normalized)) {
    printAuthUsage();
    return;
  }

  const parsed = parseUnifiedProviderArgs(normalized);
  if (!parsed.provider) {
    throw new Error(
      `Unknown auth login provider "${normalized[0]}". Use \`hybridai\`, \`codex\`, \`openrouter\`, or \`local\`.`,
    );
  }
  if (isHelpRequest(parsed.remaining)) {
    printUnifiedProviderUsage(parsed.provider);
    return;
  }

  if (parsed.provider === 'hybridai') {
    await handleHybridAICommand(['login', ...parsed.remaining]);
    return;
  }
  if (parsed.provider === 'codex') {
    await handleCodexCommand(['login', ...parsed.remaining]);
    return;
  }
  if (parsed.provider === 'openrouter') {
    await configureOpenRouter(parsed.remaining);
    return;
  }
  configureLocalBackend(parsed.remaining);
}

async function handleAuthCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0) {
    printAuthUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printAuthUsage();
    return;
  }
  if (sub === 'whatsapp') {
    await handleAuthWhatsAppCommand(normalized.slice(1));
    return;
  }
  if (sub === 'login') {
    if (normalized.length === 1) {
      await ensureRuntimeCredentials({
        commandName: 'hybridclaw auth login',
      });
      return;
    }
    await handleAuthLoginCommand(normalized.slice(1));
    return;
  }

  if (sub === 'status') {
    await handleProviderStatusCommand(
      normalized.slice(1),
      'hybridclaw auth status',
    );
    return;
  }

  if (sub === 'logout') {
    await handleProviderLogoutCommand(
      normalized.slice(1),
      'hybridclaw auth logout',
    );
    return;
  }

  throw new Error(
    `Unknown auth subcommand: ${sub}. Use \`login\`, \`status\`, \`logout\`, or \`whatsapp\`.`,
  );
}

async function handleAuthWhatsAppCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printWhatsAppUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub !== 'reset') {
    throw new Error(
      `Unknown auth whatsapp subcommand: ${sub}. Use \`hybridclaw auth whatsapp reset\`.`,
    );
  }
  if (normalized.length > 1) {
    throw new Error(
      'Unexpected arguments for `hybridclaw auth whatsapp reset`.',
    );
  }

  const status = await getWhatsAppAuthStatus();
  await resetWhatsAppAuthState();
  console.log(`Reset WhatsApp auth state at ${WHATSAPP_AUTH_DIR}.`);
  console.log(
    status.linked
      ? 'Linked device state cleared. Re-run `hybridclaw channels whatsapp setup` to pair again.'
      : 'No linked auth was present. You can run `hybridclaw channels whatsapp setup` when you are ready to pair.',
  );
}

type ProviderAction = 'status' | 'logout';

async function dispatchProviderAction(
  provider: UnifiedProvider,
  action: ProviderAction,
): Promise<void> {
  if (provider === 'hybridai') {
    await handleHybridAICommand([action]);
    return;
  }
  if (provider === 'codex') {
    await handleCodexCommand([action]);
    return;
  }
  if (provider === 'openrouter') {
    if (action === 'status') {
      printOpenRouterStatus();
      return;
    }
    clearOpenRouterCredentials();
    return;
  }
  if (action === 'status') {
    printLocalStatus();
    return;
  }
  clearLocalBackends();
}

async function handleProviderActionCommand(
  args: string[],
  commandName: string,
  action: ProviderAction,
): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printAuthUsage();
    return;
  }

  const parsed = parseUnifiedProviderArgs(normalized);
  if (!parsed.provider) {
    throw new Error(
      `Unknown ${action} provider "${normalized[0]}". Use \`hybridai\`, \`codex\`, \`openrouter\`, or \`local\`.`,
    );
  }
  if (parsed.remaining.length > 0) {
    if (isHelpRequest(parsed.remaining)) {
      printUnifiedProviderUsage(parsed.provider);
      return;
    }
    throw new Error(`Unexpected arguments for \`${commandName}\`.`);
  }

  await dispatchProviderAction(parsed.provider, action);
}

async function handleProviderStatusCommand(
  args: string[],
  commandName: string,
): Promise<void> {
  await handleProviderActionCommand(args, commandName, 'status');
}

async function handleProviderLogoutCommand(
  args: string[],
  commandName: string,
): Promise<void> {
  await handleProviderActionCommand(args, commandName, 'logout');
}

function parseWhatsAppSetupArgs(args: string[]): {
  allowFrom: string[];
  reset: boolean;
} {
  const allowFrom: string[] = [];
  let reset = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--reset') {
      reset = true;
      continue;
    }
    if (arg === '--allow-from') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--allow-from`.');
      const normalized = normalizePhoneNumber(next);
      if (!normalized) {
        throw new Error(
          `Invalid WhatsApp phone number: ${next}. Use E.164 format like +491701234567.`,
        );
      }
      allowFrom.push(normalized);
      index += 1;
      continue;
    }
    if (arg.startsWith('--allow-from=')) {
      const raw = arg.slice('--allow-from='.length);
      const normalized = normalizePhoneNumber(raw);
      if (!normalized) {
        throw new Error(
          `Invalid WhatsApp phone number: ${raw}. Use E.164 format like +491701234567.`,
        );
      }
      allowFrom.push(normalized);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...\`.`,
    );
  }

  return {
    allowFrom: [...new Set(allowFrom)],
    reset,
  };
}

function parseIntegerFlagValue(
  flagName: string,
  raw: string,
  options?: {
    min?: number;
    max?: number;
  },
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid value for \`${flagName}\`: ${raw}`);
  }
  const integer = Math.trunc(parsed);
  if (options?.min != null && integer < options.min) {
    throw new Error(`\`${flagName}\` must be at least ${options.min}.`);
  }
  if (options?.max != null && integer > options.max) {
    throw new Error(`\`${flagName}\` must be at most ${options.max}.`);
  }
  return integer;
}

function parseEmailSetupArgs(args: string[]): {
  address: string | null;
  password: string | null;
  imapHost: string | null;
  imapPort: number | null;
  smtpHost: string | null;
  smtpPort: number | null;
  pollIntervalMs: number | null;
  folders: string[];
  allowFrom: string[];
  textChunkLimit: number | null;
  mediaMaxMb: number | null;
} {
  let address: string | null = null;
  let password: string | null = null;
  let imapHost: string | null = null;
  let imapPort: number | null = null;
  let smtpHost: string | null = null;
  let smtpPort: number | null = null;
  let pollIntervalMs: number | null = null;
  let textChunkLimit: number | null = null;
  let mediaMaxMb: number | null = null;
  const folders: string[] = [];
  const allowFrom: string[] = [];

  const parseAllowFrom = (raw: string): string => {
    const normalized = normalizeEmailAllowEntry(raw);
    if (!normalized) {
      throw new Error(
        `Invalid email allowlist entry: ${raw}. Use an email address, *@example.com, or *.`,
      );
    }
    return normalized;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--address') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--address`.');
      const normalized = normalizeEmailAddress(next);
      if (!normalized) {
        throw new Error(`Invalid email address: ${next}`);
      }
      address = normalized;
      index += 1;
      continue;
    }
    if (arg.startsWith('--address=')) {
      const raw = arg.slice('--address='.length);
      const normalized = normalizeEmailAddress(raw);
      if (!normalized) {
        throw new Error(`Invalid email address: ${raw}`);
      }
      address = normalized;
      continue;
    }
    if (arg === '--password') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--password`.');
      password = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length).trim() || null;
      continue;
    }
    if (arg === '--imap-host') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--imap-host`.');
      imapHost = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--imap-host=')) {
      imapHost = arg.slice('--imap-host='.length).trim() || null;
      continue;
    }
    if (arg === '--imap-port') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--imap-port`.');
      imapPort = parseIntegerFlagValue('--imap-port', next, {
        min: 1,
        max: 65_535,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--imap-port=')) {
      imapPort = parseIntegerFlagValue(
        '--imap-port',
        arg.slice('--imap-port='.length),
        {
          min: 1,
          max: 65_535,
        },
      );
      continue;
    }
    if (arg === '--smtp-host') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--smtp-host`.');
      smtpHost = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--smtp-host=')) {
      smtpHost = arg.slice('--smtp-host='.length).trim() || null;
      continue;
    }
    if (arg === '--smtp-port') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--smtp-port`.');
      smtpPort = parseIntegerFlagValue('--smtp-port', next, {
        min: 1,
        max: 65_535,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--smtp-port=')) {
      smtpPort = parseIntegerFlagValue(
        '--smtp-port',
        arg.slice('--smtp-port='.length),
        {
          min: 1,
          max: 65_535,
        },
      );
      continue;
    }
    if (arg === '--poll-interval-ms') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--poll-interval-ms`.');
      pollIntervalMs = parseIntegerFlagValue('--poll-interval-ms', next, {
        min: 1_000,
        max: 3_600_000,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--poll-interval-ms=')) {
      pollIntervalMs = parseIntegerFlagValue(
        '--poll-interval-ms',
        arg.slice('--poll-interval-ms='.length),
        {
          min: 1_000,
          max: 3_600_000,
        },
      );
      continue;
    }
    if (arg === '--folder') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--folder`.');
      folders.push(next.trim());
      index += 1;
      continue;
    }
    if (arg.startsWith('--folder=')) {
      folders.push(arg.slice('--folder='.length).trim());
      continue;
    }
    if (arg === '--allow-from') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--allow-from`.');
      allowFrom.push(parseAllowFrom(next));
      index += 1;
      continue;
    }
    if (arg.startsWith('--allow-from=')) {
      allowFrom.push(parseAllowFrom(arg.slice('--allow-from='.length)));
      continue;
    }
    if (arg === '--text-chunk-limit') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--text-chunk-limit`.');
      textChunkLimit = parseIntegerFlagValue('--text-chunk-limit', next, {
        min: 500,
        max: 200_000,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--text-chunk-limit=')) {
      textChunkLimit = parseIntegerFlagValue(
        '--text-chunk-limit',
        arg.slice('--text-chunk-limit='.length),
        {
          min: 500,
          max: 200_000,
        },
      );
      continue;
    }
    if (arg === '--media-max-mb') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--media-max-mb`.');
      mediaMaxMb = parseIntegerFlagValue('--media-max-mb', next, {
        min: 1,
        max: 100,
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--media-max-mb=')) {
      mediaMaxMb = parseIntegerFlagValue(
        '--media-max-mb',
        arg.slice('--media-max-mb='.length),
        {
          min: 1,
          max: 100,
        },
      );
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--smtp-host <host>]\`.`,
    );
  }

  return {
    address,
    password,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    pollIntervalMs,
    folders: [...new Set(folders.filter(Boolean))],
    allowFrom: [...new Set(allowFrom)],
    textChunkLimit,
    mediaMaxMb,
  };
}

function normalizeDiscordUserId(raw: string): string | null {
  const trimmed = raw.trim();
  const mentionMatch = trimmed.match(/^<@!?(\d{16,22})>$/);
  if (mentionMatch) return mentionMatch[1];
  const directMatch = trimmed.match(/^(?:user:|discord:)?(\d{16,22})$/i);
  return directMatch ? directMatch[1] : null;
}

function parseDiscordSetupArgs(args: string[]): {
  token: string | null;
  allowUserIds: string[];
  prefix: string | null;
} {
  let token: string | null = null;
  let prefix: string | null = null;
  const allowUserIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--token') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--token`.');
      token = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--token=')) {
      token = arg.slice('--token='.length).trim() || null;
      continue;
    }
    if (arg === '--allow-user-id') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--allow-user-id`.');
      const normalized = normalizeDiscordUserId(next);
      if (!normalized) {
        throw new Error(
          `Invalid Discord user id: ${next}. Use a Discord snowflake like 123456789012345678.`,
        );
      }
      allowUserIds.push(normalized);
      index += 1;
      continue;
    }
    if (arg.startsWith('--allow-user-id=')) {
      const raw = arg.slice('--allow-user-id='.length);
      const normalized = normalizeDiscordUserId(raw);
      if (!normalized) {
        throw new Error(
          `Invalid Discord user id: ${raw}. Use a Discord snowflake like 123456789012345678.`,
        );
      }
      allowUserIds.push(normalized);
      continue;
    }
    if (arg === '--prefix') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--prefix`.');
      prefix = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--prefix=')) {
      prefix = arg.slice('--prefix='.length).trim() || null;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]\`.`,
    );
  }

  return {
    token,
    allowUserIds: [...new Set(allowUserIds)],
    prefix,
  };
}

async function promptWithDefault(params: {
  rl: readline.Interface;
  question: string;
  defaultValue?: string;
  validate?: (value: string) => string | null;
  errorMessage?: string;
}): Promise<string> {
  while (true) {
    const suffix = params.defaultValue ? ` [${params.defaultValue}]` : '';
    const raw = (
      await params.rl.question(`${params.question}${suffix}: `)
    ).trim();
    const candidate = raw || params.defaultValue || '';
    const validated = params.validate ? params.validate(candidate) : candidate;
    if (validated) return validated;
    console.log(params.errorMessage || 'Please enter a valid value.');
  }
}

async function resolveInteractiveEmailSetup(params: {
  address: string;
  allowFrom: string[];
  imapHost: string;
  imapPort: number;
  password: string;
  smtpHost: string;
  smtpPort: number;
}): Promise<{
  address: string;
  allowFrom: string[];
  imapHost: string;
  imapPort: number;
  password: string;
  passwordSource: 'explicit' | 'prompt' | 'env';
  smtpHost: string;
  smtpPort: number;
}> {
  let address = params.address;
  let imapHost = params.imapHost;
  let smtpHost = params.smtpHost;
  let password = params.password;
  let passwordSource: 'explicit' | 'prompt' | 'env' = password
    ? 'explicit'
    : process.env.EMAIL_PASSWORD?.trim()
      ? 'env'
      : 'prompt';
  let allowFrom = params.allowFrom;

  const needsPrompt = !address || !imapHost || !smtpHost || !password;
  if (!needsPrompt) {
    return {
      address,
      allowFrom,
      imapHost,
      imapPort: params.imapPort,
      password,
      passwordSource,
      smtpHost,
      smtpPort: params.smtpPort,
    };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Missing email setup fields. Pass them as flags or run this command in an interactive terminal to be prompted.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    address = await promptWithDefault({
      rl,
      question: 'Email address',
      defaultValue: address || undefined,
      validate: normalizeEmailAddress,
      errorMessage: 'Enter a valid email address.',
    });
    imapHost = await promptWithDefault({
      rl,
      question: 'IMAP host',
      defaultValue: imapHost || undefined,
    });
    const imapPortRaw = await promptWithDefault({
      rl,
      question: 'IMAP port',
      defaultValue: String(params.imapPort),
      validate: (value) => {
        try {
          return String(
            parseIntegerFlagValue('--imap-port', value, {
              min: 1,
              max: 65_535,
            }),
          );
        } catch {
          return null;
        }
      },
      errorMessage: 'Enter a valid IMAP port.',
    });
    smtpHost = await promptWithDefault({
      rl,
      question: 'SMTP host',
      defaultValue: smtpHost || undefined,
    });
    const smtpPortRaw = await promptWithDefault({
      rl,
      question: 'SMTP port',
      defaultValue: String(params.smtpPort),
      validate: (value) => {
        try {
          return String(
            parseIntegerFlagValue('--smtp-port', value, {
              min: 1,
              max: 65_535,
            }),
          );
        } catch {
          return null;
        }
      },
      errorMessage: 'Enter a valid SMTP port.',
    });

    if (!password) {
      password = await promptWithDefault({
        rl,
        question: 'Email password or app password',
      });
      passwordSource = 'prompt';
    }

    if (allowFrom.length === 0) {
      const allowFromRaw = (
        await rl.question(
          'Allowed inbound senders (optional, comma-separated emails, *@domain, or *): ',
        )
      ).trim();
      if (allowFromRaw) {
        allowFrom = allowFromRaw
          .split(',')
          .map((entry) => normalizeEmailAllowEntry(entry))
          .filter((entry): entry is string => Boolean(entry));
      }
    }

    return {
      address,
      allowFrom: [...new Set(allowFrom)],
      imapHost,
      imapPort: Number(imapPortRaw),
      password,
      passwordSource,
      smtpHost,
      smtpPort: Number(smtpPortRaw),
    };
  } finally {
    rl.close();
  }
}

function configureDiscordChannel(args: string[]): void {
  ensureRuntimeConfigFile();
  const parsed = parseDiscordSetupArgs(args);
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.discord.commandsOnly = true;
    draft.discord.commandMode = 'restricted';
    draft.discord.commandAllowedUserIds = parsed.allowUserIds;
    draft.discord.commandUserId = '';
    draft.discord.groupPolicy = 'disabled';
    draft.discord.freeResponseChannels = [];
    draft.discord.guilds = {};
    if (parsed.prefix) {
      draft.discord.prefix = parsed.prefix;
    }
  });
  const secretsPath = parsed.token
    ? saveRuntimeSecrets({ DISCORD_TOKEN: parsed.token })
    : runtimeSecretsPath();

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  if (parsed.token) {
    console.log(`Saved Discord token to ${secretsPath}.`);
  } else {
    console.log(`Discord token unchanged. Secrets path: ${secretsPath}`);
  }
  console.log('Discord mode: command-only');
  console.log(`Discord prefix: ${nextConfig.discord.prefix}`);
  console.log(`Guild command mode: ${nextConfig.discord.commandMode}`);
  console.log(`Guild message policy: ${nextConfig.discord.groupPolicy}`);
  if (nextConfig.discord.commandAllowedUserIds.length > 0) {
    console.log(
      `Allowed guild users: ${nextConfig.discord.commandAllowedUserIds.join(', ')}`,
    );
  } else {
    console.log(
      'Allowed guild users: none configured (guild commands stay locked down until you add one)',
    );
  }
  console.log('Next:');
  console.log('  If provider auth is not set up yet: hybridclaw onboarding');
  if (!parsed.token) {
    console.log(
      `  Save DISCORD_TOKEN in ${secretsPath} or rerun with --token <token>`,
    );
  }
  console.log('  Restart the gateway to pick up Discord settings:');
  console.log('    hybridclaw gateway restart --foreground');
  console.log('    hybridclaw gateway status');
  console.log('  Invite the Discord bot to your server or open a DM with it');
  if (nextConfig.discord.commandAllowedUserIds.length > 0) {
    console.log(
      `  Test with an allowlisted guild user id: ${nextConfig.discord.commandAllowedUserIds[0]}`,
    );
  } else {
    console.log('  Use DMs first, or rerun with --allow-user-id <snowflake>');
  }
}

async function configureEmailChannel(args: string[]): Promise<void> {
  ensureRuntimeConfigFile();
  const parsed = parseEmailSetupArgs(args);
  const currentConfig = getRuntimeConfig().email;

  const resolved = await resolveInteractiveEmailSetup({
    address: parsed.address || currentConfig.address,
    allowFrom:
      parsed.allowFrom.length > 0 ? parsed.allowFrom : currentConfig.allowFrom,
    imapHost: parsed.imapHost || currentConfig.imapHost,
    imapPort: parsed.imapPort || currentConfig.imapPort,
    password:
      parsed.password?.trim() || process.env.EMAIL_PASSWORD?.trim() || '',
    smtpHost: parsed.smtpHost || currentConfig.smtpHost,
    smtpPort: parsed.smtpPort || currentConfig.smtpPort,
  });

  const nextConfig = updateRuntimeConfig((draft) => {
    draft.email.enabled = true;
    draft.email.address = resolved.address;
    draft.email.imapHost = resolved.imapHost;
    draft.email.imapPort = resolved.imapPort;
    draft.email.smtpHost = resolved.smtpHost;
    draft.email.smtpPort = resolved.smtpPort;
    draft.email.pollIntervalMs =
      parsed.pollIntervalMs || draft.email.pollIntervalMs;
    draft.email.folders =
      parsed.folders.length > 0 ? parsed.folders : draft.email.folders;
    draft.email.allowFrom = resolved.allowFrom;
    draft.email.textChunkLimit =
      parsed.textChunkLimit || draft.email.textChunkLimit;
    draft.email.mediaMaxMb = parsed.mediaMaxMb || draft.email.mediaMaxMb;
  });

  const shouldSavePassword =
    resolved.passwordSource === 'prompt' || Boolean(parsed.password?.trim());
  const secretsPath = shouldSavePassword
    ? saveRuntimeSecrets({ EMAIL_PASSWORD: resolved.password })
    : runtimeSecretsPath();

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  if (shouldSavePassword) {
    console.log(`Saved email password to ${secretsPath}.`);
  } else {
    console.log(`Email password unchanged. Secrets path: ${secretsPath}`);
  }
  console.log('Email mode: enabled');
  console.log(`Email address: ${nextConfig.email.address}`);
  console.log(
    `IMAP: ${nextConfig.email.imapHost}:${nextConfig.email.imapPort}`,
  );
  console.log(
    `SMTP: ${nextConfig.email.smtpHost}:${nextConfig.email.smtpPort}`,
  );
  console.log(`Folders: ${nextConfig.email.folders.join(', ')}`);
  if (nextConfig.email.allowFrom.length > 0) {
    console.log(`Allowed senders: ${nextConfig.email.allowFrom.join(', ')}`);
  } else {
    console.log('Allowed senders: none (inbound email stays disabled)');
  }
  console.log(`Poll interval: ${nextConfig.email.pollIntervalMs}ms`);
  console.log(`Text chunk limit: ${nextConfig.email.textChunkLimit}`);
  console.log(`Media limit: ${nextConfig.email.mediaMaxMb}MB`);
  console.log('Next:');
  console.log('  Restart the gateway to pick up email settings:');
  console.log('    hybridclaw gateway restart --foreground');
  console.log('    hybridclaw gateway status');
  if (nextConfig.email.allowFrom.length > 0) {
    console.log(
      `  Send a test message from an allowlisted sender to ${nextConfig.email.address}`,
    );
  } else {
    console.log(
      '  Add one or more allowlisted senders to receive inbound mail, or use email only for outbound sends',
    );
  }
}

async function pairWhatsAppChannel(): Promise<void> {
  const settleMs = resolveWhatsAppSetupSettleMs();
  const manager = createWhatsAppConnectionManager();
  try {
    console.log('Opening WhatsApp pairing session...');
    console.log(
      'Scan the QR code in WhatsApp: Settings > Linked Devices > Link a Device',
    );
    await manager.start();
    const socket = await manager.waitForSocket();
    console.log(`WhatsApp linked: ${socket.user?.id || 'connected'}`);
    if (settleMs > 0) {
      console.log(
        `Keeping the temporary setup session open for ${Math.floor(settleMs / 1000)}s so WhatsApp can finish linking...`,
      );
      await sleep(settleMs);
    }
  } finally {
    await manager.stop().catch(() => {});
  }
}

async function configureWhatsAppChannel(args: string[]): Promise<void> {
  ensureRuntimeConfigFile();
  const parsed = parseWhatsAppSetupArgs(args);
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.whatsapp.groupPolicy = 'disabled';
    draft.whatsapp.groupAllowFrom = [];
    draft.whatsapp.ackReaction = draft.whatsapp.ackReaction.trim() || '👀';
    if (parsed.allowFrom.length > 0) {
      draft.whatsapp.dmPolicy = 'allowlist';
      draft.whatsapp.allowFrom = parsed.allowFrom;
      return;
    }
    draft.whatsapp.dmPolicy = 'disabled';
    draft.whatsapp.allowFrom = [];
  });

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(
    `WhatsApp mode: ${parsed.allowFrom.length > 0 ? 'allowlisted DMs only' : 'self-chat only'}`,
  );
  console.log(`DM policy: ${nextConfig.whatsapp.dmPolicy}`);
  if (nextConfig.whatsapp.allowFrom.length > 0) {
    console.log(`Allowed senders: ${nextConfig.whatsapp.allowFrom.join(', ')}`);
  }
  console.log(`Group policy: ${nextConfig.whatsapp.groupPolicy}`);
  console.log(
    `Ack reaction: ${nextConfig.whatsapp.ackReaction.trim() || '(disabled)'}`,
  );
  console.log(`Auth directory: ${WHATSAPP_AUTH_DIR}`);
  if (parsed.reset) {
    await resetWhatsAppAuthState();
    console.log(`Reset WhatsApp auth state at ${WHATSAPP_AUTH_DIR}`);
  }
  await pairWhatsAppChannel();
}

async function handleChannelsCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printChannelsUsage();
    return;
  }

  const channel = normalized[0].toLowerCase();
  if (channel !== 'whatsapp' && channel !== 'discord' && channel !== 'email') {
    throw new Error(
      `Unknown channel "${normalized[0]}". Currently supported: \`discord\`, \`whatsapp\`, \`email\`.`,
    );
  }

  const sub = (normalized[1] || '').toLowerCase();
  if (!sub || isHelpRequest([sub])) {
    printChannelsUsage();
    return;
  }
  if (sub === 'setup') {
    if (channel === 'discord') {
      configureDiscordChannel(normalized.slice(2));
      return;
    }
    if (channel === 'email') {
      await configureEmailChannel(normalized.slice(2));
      return;
    }
    await configureWhatsAppChannel(normalized.slice(2));
    return;
  }

  throw new Error(
    `Unknown channels subcommand: ${sub}. Use \`hybridclaw channels discord setup\`, \`hybridclaw channels whatsapp setup\`, or \`hybridclaw channels email setup\`.`,
  );
}

async function handleHybridAICommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printHybridAIUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'login') {
    const method = parseHybridAILoginMethod(normalized.slice(1));
    const result = await loginHybridAIInteractive({ method });
    console.log(`Saved HybridAI credentials to ${result.path}.`);
    console.log(`Login method: ${result.method}`);
    console.log(`API key: ${result.maskedApiKey}`);
    console.log(`Validated: ${result.validated ? 'yes' : 'no'}`);
    return;
  }

  if (sub === 'logout') {
    const filePath = clearHybridAICredentials();
    console.log(`Cleared HybridAI credentials in ${filePath}.`);
    console.log(
      'If HYBRIDAI_API_KEY is still exported in your shell, unset it separately.',
    );
    return;
  }

  if (sub === 'status') {
    const status = getHybridAIAuthStatus();
    console.log(`Path: ${status.path}`);
    console.log(`Authenticated: ${status.authenticated ? 'yes' : 'no'}`);
    if (status.authenticated) {
      console.log(`Source: ${status.source}`);
      console.log(`API key: ${status.maskedApiKey}`);
    }
    return;
  }

  throw new Error(`Unknown hybridai subcommand: ${sub}`);
}

async function handleCodexCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printCodexUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'login') {
    const method = parseCodexLoginMethod(normalized.slice(1));
    const result = await loginCodexInteractive({ method });
    console.log(`Saved Codex credentials to ${result.path}.`);
    console.log(`Account: ${result.credentials.accountId}`);
    console.log(`Source: ${result.method}`);
    console.log(
      `Expires: ${new Date(result.credentials.expiresAt).toISOString()}`,
    );
    return;
  }

  if (sub === 'logout') {
    const filePath = clearCodexCredentials();
    console.log(`Cleared Codex credentials in ${filePath}.`);
    return;
  }

  if (sub === 'status') {
    const status = getCodexAuthStatus();
    console.log(`Path: ${status.path}`);
    console.log(`Authenticated: ${status.authenticated ? 'yes' : 'no'}`);
    console.log(`Relogin required: ${status.reloginRequired ? 'yes' : 'no'}`);
    if (status.authenticated) {
      console.log(`Source: ${status.source}`);
      console.log(`Account: ${status.accountId}`);
      console.log(`Access token: ${status.maskedAccessToken}`);
      console.log(
        `Expires: ${status.expiresAt ? new Date(status.expiresAt).toISOString() : 'unknown'}`,
      );
    }
    return;
  }

  throw new Error(`Unknown codex subcommand: ${sub}`);
}

async function handleSkillCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printSkillUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'list') {
    const { loadSkillCatalog } = await import('./skills/skills.js');
    const { resolveSkillInstallId } = await import(
      './skills/skills-install.js'
    );
    const catalog = loadSkillCatalog();
    for (const skill of catalog) {
      const availability = skill.available
        ? 'available'
        : skill.missing.join(', ');
      console.log(`${skill.name} [${availability}]`);
      const installs = skill.metadata.hybridclaw.install || [];
      for (const [index, spec] of installs.entries()) {
        const installId = resolveSkillInstallId(spec, index);
        const label = spec.label ? ` — ${spec.label}` : '';
        console.log(`  ${installId} (${spec.kind})${label}`);
      }
    }
    return;
  }

  if (sub === 'install') {
    const skillName = normalized[1];
    const installId = normalized[2];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill install`.');
    }

    const { installSkillDependency } = await import(
      './skills/skills-install.js'
    );
    const result = await installSkillDependency({ skillName, installId });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (!result.ok) {
      throw new Error(result.message);
    }
    console.log(result.message);
    return;
  }

  throw new Error(`Unknown skill subcommand: ${sub}`);
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const command = argv[0];
  const subargs = argv.slice(1);

  switch (command) {
    case '--version':
    case '-v':
      console.log(APP_VERSION);
      break;
    case 'auth':
      await handleAuthCommand(subargs);
      break;
    case 'gateway':
      await handleGatewayCommand(subargs);
      break;
    case 'tui':
      if (isHelpRequest(subargs)) {
        printTuiUsage();
        break;
      }
      await ensureTuiInstructionApproval('hybridclaw tui');
      await ensureGatewayForTui('hybridclaw tui');
      await import('./tui.js');
      break;
    case 'onboarding':
      if (isHelpRequest(subargs)) {
        printOnboardingUsage();
        break;
      }
      await ensureRuntimeCredentials({
        force: true,
        commandName: 'hybridclaw onboarding',
      });
      await ensureRuntimeContainer('hybridclaw onboarding', false);
      break;
    case 'channels':
      await handleChannelsCommand(subargs);
      break;
    case 'local':
      printDeprecatedProviderAliasWarning('local', subargs);
      await handleLocalCommand(subargs);
      break;
    case 'hybridai':
      printDeprecatedProviderAliasWarning('hybridai', subargs);
      await handleHybridAICommand(subargs);
      break;
    case 'codex':
      printDeprecatedProviderAliasWarning('codex', subargs);
      await handleCodexCommand(subargs);
      break;
    case 'skill':
      await handleSkillCommand(subargs);
      break;
    case 'update': {
      if (isHelpRequest(subargs)) {
        printUpdateUsage();
        break;
      }
      await runUpdateCommand(subargs, APP_VERSION);
      break;
    }
    case 'audit': {
      if (isHelpRequest(subargs)) {
        printAuditUsage();
        break;
      }
      const { runAuditCli } = await import('./audit/audit-cli.js');
      await runAuditCli(subargs);
      break;
    }
    case 'help': {
      const topic = (subargs[0] || '').trim().toLowerCase();
      if (!topic) {
        printMainUsage();
        console.log('');
        printHelpUsage();
        break;
      }
      if (printHelpTopic(topic)) {
        break;
      }
      printMainUsage();
      console.log('');
      printHelpUsage();
      console.error(`Unknown help topic: ${topic}`);
      process.exit(1);
      break;
    }
    default:
      printMainUsage();
      process.exit(command ? 1 : 0);
  }
}

function printMissingEnvVarError(message: string, envVar?: string): void {
  const envVarHint: Record<string, string> = {
    HYBRIDAI_API_KEY: `Set HYBRIDAI_API_KEY in ${runtimeSecretsPath()} or your shell, then run the command again. You can also run \`hybridclaw onboarding\` to set it interactively.`,
    OPENROUTER_API_KEY: `Set OPENROUTER_API_KEY in ${runtimeSecretsPath()} or your shell, ensure \`openrouter.enabled\` is true in ${runtimeConfigPath()}, then run the command again.`,
  };
  const hint = envVar
    ? envVarHint[envVar]
    : 'Set this variable and rerun the command.';
  console.error(`hybridclaw error: ${message}`);
  console.error(`Hint: ${hint}`);
  console.error(
    `HybridClaw stores runtime secrets in ${runtimeSecretsPath()}. If .env exists in the current working directory, supported secrets are migrated there automatically.`,
  );
}

export function isDirectExecution(
  entry: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!entry) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(entry) === modulePath;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    if (err instanceof MissingRequiredEnvVarError) {
      printMissingEnvVarError(err.message, err.envVar);
    } else if (err instanceof CodexAuthError) {
      console.error(`hybridclaw error: ${err.message}`);
      if (err.reloginRequired) {
        console.error(
          'Hint: Run `hybridclaw auth login codex` or `hybridclaw onboarding` to refresh OpenAI Codex credentials.',
        );
      }
    } else if (err instanceof WhatsAppAuthLockError) {
      console.error(`hybridclaw error: ${err.message}`);
      console.error(
        'Hint: Stop the other HybridClaw process that owns WhatsApp, unlink the stale Linked Device if needed, then rerun `hybridclaw auth whatsapp reset` or `hybridclaw channels whatsapp setup`.',
      );
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`hybridclaw error: ${message}`);
    }
    process.exit(1);
  });
}
