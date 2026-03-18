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
import type { SkillConfigChannelKind } from './channels/channel.js';
import { normalizeSkillConfigChannelKind } from './channels/channel-registry.js';
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
  GATEWAY_BASE_URL,
  getResolvedSandboxMode,
  MissingRequiredEnvVarError,
  setSandboxModeOverride,
} from './config/config.js';
import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  getRuntimeSkillScopeDisabledNames,
  runtimeConfigPath,
  setRuntimeSkillScopeEnabled,
  updateRuntimeConfig,
} from './config/runtime-config.js';
import {
  ensureGatewayRunDir,
  GATEWAY_LOG_FILE_ENV,
  GATEWAY_LOG_PATH,
  GATEWAY_LOG_REQUESTS_ENV,
  GATEWAY_STDIO_TO_LOG_ENV,
  type GatewayPidState,
  isPidRunning,
  readGatewayPid,
  removeGatewayPidFile,
  writeGatewayPid,
} from './gateway/gateway-lifecycle.js';
import { ensureRuntimeCredentials } from './onboarding.js';
import { formatPluginSummaryList } from './plugins/plugin-formatting.js';
import type { LocalBackendType } from './providers/local-types.js';
import {
  runtimeSecretsPath,
  saveRuntimeSecrets,
} from './security/runtime-secrets.js';
import type {
  SkillAmendment,
  SkillHealthMetrics,
  SkillObservation,
} from './skills/adaptive-skills-types.js';
import { printUpdateUsage, runUpdateCommand } from './update.js';
import { sleep } from './utils/sleep.js';

const GATEWAY_LOG_REQUESTS_WARNING =
  'Gateway request logging enabled. request_log stores best-effort redacted prompts, responses, and tool payloads for debugging. Treat this log as potentially sensitive.';
const PACKAGE_NAME = '@hybridaione/hybridclaw';
let cachedInstallRoot: string | null = null;
let foregroundGatewayExitHandler: (() => void) | null = null;
let foregroundGatewaySigintHandler: (() => void) | null = null;
let foregroundGatewaySigtermHandler: (() => void) | null = null;

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

function cleanupForegroundGatewayPidFile(): void {
  try {
    removeGatewayPidFile();
  } catch {
    // best effort during process teardown
  }
}

function removeForegroundGatewayPidHandlers(): void {
  if (foregroundGatewayExitHandler) {
    process.removeListener('exit', foregroundGatewayExitHandler);
    foregroundGatewayExitHandler = null;
  }
  if (foregroundGatewaySigintHandler) {
    process.removeListener('SIGINT', foregroundGatewaySigintHandler);
    foregroundGatewaySigintHandler = null;
  }
  if (foregroundGatewaySigtermHandler) {
    process.removeListener('SIGTERM', foregroundGatewaySigtermHandler);
    foregroundGatewaySigtermHandler = null;
  }
}

function registerForegroundGatewayPid(commandName: string): {
  markReady: () => void;
  cleanup: () => void;
} {
  removeForegroundGatewayPidHandlers();
  cleanupForegroundGatewayPidFile();

  let ready = false;
  const handleExit = () => {
    cleanupForegroundGatewayPidFile();
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    cleanupForegroundGatewayPidFile();
    removeForegroundGatewayPidHandlers();
    if (ready) return;
    try {
      process.kill(process.pid, signal);
    } catch {
      // best effort; allow the current process state to unwind
    }
  };

  foregroundGatewayExitHandler = handleExit;
  foregroundGatewaySigintHandler = () => {
    handleSignal('SIGINT');
  };
  foregroundGatewaySigtermHandler = () => {
    handleSignal('SIGTERM');
  };

  process.on('exit', foregroundGatewayExitHandler);
  process.on('SIGINT', foregroundGatewaySigintHandler);
  process.on('SIGTERM', foregroundGatewaySigtermHandler);

  writeGatewayPid({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    command:
      process.argv.length > 1
        ? [process.execPath, ...process.argv.slice(1)]
        : [commandName],
  });

  return {
    markReady: () => {
      ready = true;
    },
    cleanup: () => {
      cleanupForegroundGatewayPidFile();
      removeForegroundGatewayPidHandlers();
    },
  };
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
  sessionId = 'tui:local',
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
    sessionId,
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
  plugin     Manage HybridClaw plugins
  skill      List skill dependency installers or run one
  update     Check and apply HybridClaw CLI updates
  audit      Inspect/verify structured audit trail
  doctor     Run environment and runtime diagnostics
  help       Show general or topic-specific help (e.g. \`hybridclaw help gateway\`)

  Options:
  --resume <id>  Resume a saved TUI session
  --version, -v  Show HybridClaw CLI version`);
}

function printGatewayUsage(): void {
  console.log(`Usage: hybridclaw gateway <subcommand>

Commands:
  hybridclaw gateway
  hybridclaw gateway start [--foreground] [--debug] [--log-requests] [--sandbox=container|host]
  hybridclaw gateway restart [--foreground] [--debug] [--log-requests] [--sandbox=container|host]
  hybridclaw gateway stop
  hybridclaw gateway status
  hybridclaw gateway sessions
  hybridclaw gateway bot info
  hybridclaw gateway show [all|thinking|tools|none]
  hybridclaw gateway reset [yes|no]
  hybridclaw gateway <discord-style command ...>`);
}

interface ParsedTuiArgs {
  help: boolean;
  resumeSessionId: string | null;
}

function parseResumeFlagValue(
  arg: string,
  nextArg: string | undefined,
): {
  value: string;
  consumedNextArg: boolean;
} | null {
  if (arg === '--resume' || arg === '-r') {
    const value = String(nextArg || '').trim();
    if (!value) {
      throw new Error(
        'Missing value for `--resume`. Use `hybridclaw --resume <sessionId>` or `hybridclaw tui --resume <sessionId>`.',
      );
    }
    return { value, consumedNextArg: true };
  }

  if (arg.startsWith('--resume=')) {
    const value = arg.slice('--resume='.length).trim();
    if (!value) {
      throw new Error(
        'Missing value for `--resume`. Use `hybridclaw --resume <sessionId>` or `hybridclaw tui --resume <sessionId>`.',
      );
    }
    return { value, consumedNextArg: false };
  }

  return null;
}

function parseTuiArgs(argv: string[]): ParsedTuiArgs {
  let help = false;
  let resumeSessionId: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;

    if (arg === '--help' || arg === '-h' || arg === 'help') {
      help = true;
      continue;
    }

    const resume = parseResumeFlagValue(arg, argv[i + 1]);
    if (resume) {
      resumeSessionId = resume.value;
      if (resume.consumedNextArg) i += 1;
      continue;
    }

    throw new Error(`Unexpected TUI option: ${arg}`);
  }

  return { help, resumeSessionId };
}

async function launchTui(argv: string[]): Promise<void> {
  const parsed = parseTuiArgs(argv);
  if (parsed.help) {
    printTuiUsage();
    return;
  }

  const { resolveTuiRunOptions } = await import('./tui-session.js');
  const options = resolveTuiRunOptions({
    resumeSessionId: parsed.resumeSessionId,
    resumeCommand: 'hybridclaw tui --resume',
  });
  await ensureTuiInstructionApproval('hybridclaw tui', options.sessionId);
  await ensureGatewayForTui('hybridclaw tui');
  const { runTui } = await import('./tui.js');
  await runTui(options);
}

function printTuiUsage(): void {
  console.log(`Usage:
  hybridclaw tui [--resume <sessionId>]
  hybridclaw --resume <sessionId>

Starts the terminal adapter and connects to the running gateway.
If gateway is not running, it is started in backend mode automatically.
By default, \`hybridclaw tui\` starts a fresh local CLI session.

Interactive slash commands inside TUI:
  /help   /status   /approve [view|yes|session|agent|no] [approval_id]
  /show [all|thinking|tools|none]
  /agent [list|switch|create|model]   /bot [info|list|set <id|name>]
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
  hybridclaw auth login <hybridai|codex|openrouter|local|msteams> ...
  hybridclaw auth status <hybridai|codex|openrouter|local|msteams>
  hybridclaw auth logout <hybridai|codex|openrouter|local|msteams>
  hybridclaw auth whatsapp reset

Examples:
  hybridclaw auth login
  hybridclaw auth login hybridai --browser
  hybridclaw auth login codex --import
  hybridclaw auth login openrouter anthropic/claude-sonnet-4 --api-key sk-or-...
  hybridclaw auth login local ollama llama3.2
  hybridclaw auth login msteams --app-id 00000000-0000-0000-0000-000000000000 --tenant-id 11111111-1111-1111-1111-111111111111 --app-password secret
  hybridclaw auth whatsapp reset
  hybridclaw auth status openrouter
  hybridclaw auth status msteams
  hybridclaw auth logout codex
  hybridclaw auth logout msteams

Notes:
  - \`auth login\` without a provider runs the normal interactive onboarding flow.
  - \`local logout\` disables configured local backends and clears any saved vLLM API key.
  - \`auth login msteams\` enables Microsoft Teams and stores \`MSTEAMS_APP_PASSWORD\` in ${runtimeSecretsPath()}.
  - \`auth whatsapp reset\` clears linked WhatsApp Web auth so you can re-pair cleanly.
  - \`auth login openrouter\` prompts for the API key when \`--api-key\` and \`OPENROUTER_API_KEY\` are both absent.
  - \`auth login msteams\` prompts for the app id, app password, and optional tenant id when the terminal is interactive.`);
}

function printChannelsUsage(): void {
  console.log(`Usage: hybridclaw channels <channel> <command>

Commands:
  hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]
  hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...
  hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--imap-port <port>] [--imap-secure|--no-imap-secure] [--smtp-host <host>] [--smtp-port <port>] [--smtp-secure|--no-smtp-secure] [--folder <name>]... [--allow-from <email|*@domain|*>]... [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>]

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
  - Email IMAP secure mode defaults to \`true\`.
  - Email SMTP secure mode defaults to \`false\` on port \`587\`; use \`--smtp-secure\` for implicit TLS on port \`465\`.
  - \`--no-smtp-secure\` is the correct setting for encrypted STARTTLS on port \`587\`; it does not force plaintext by itself.
  - Email inbound is explicit-opt-in: when email \`allowFrom\` is empty, inbound email is ignored.
  - Microsoft Teams setup lives under \`hybridclaw auth login msteams\` because it needs app credentials instead of a channel pairing flow.
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

function printMSTeamsUsage(): void {
  console.log(`Usage:
  hybridclaw auth login msteams [--app-id <id>|--client-id <id>] [--app-password <secret>|--client-secret <secret>] [--tenant-id <id>]
  hybridclaw auth status msteams
  hybridclaw auth logout msteams

Notes:
  - \`auth login msteams\` enables the Microsoft Teams integration in ${runtimeConfigPath()}.
  - \`auth login msteams\` stores \`MSTEAMS_APP_PASSWORD\` in ${runtimeSecretsPath()} and clears any plaintext \`msteams.appPassword\` value from config.
  - \`--tenant-id\` is optional.
  - If \`--app-password\` is omitted and \`MSTEAMS_APP_PASSWORD\` is already set, HybridClaw reuses that value.
  - If \`--app-id\` or \`--app-password\` is missing and the terminal is interactive, HybridClaw prompts for them and also offers an optional tenant id prompt.`);
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

function printDoctorUsage(): void {
  console.log(`Usage:
  hybridclaw doctor
  hybridclaw doctor --fix
  hybridclaw doctor --json
  hybridclaw doctor <runtime|gateway|config|credentials|database|providers|local-backends|docker|channels|skills|security|disk>

Notes:
  - Runs independent diagnostic categories in parallel and reports ok, warning, and error states.
  - \`--fix\` retries fixable checks after applying automatic remediation where supported.
  - \`--json\` prints a machine-readable report and still uses exit code 1 when any errors remain.`);
}

function printSkillUsage(): void {
  console.log(`Usage: hybridclaw skill <command>

Commands:
  hybridclaw skill list
  hybridclaw skill enable <skill-name> [--channel <kind>]
  hybridclaw skill disable <skill-name> [--channel <kind>]
  hybridclaw skill toggle [--channel <kind>]
  hybridclaw skill inspect <skill-name>
  hybridclaw skill inspect --all
  hybridclaw skill runs <skill-name>
  hybridclaw skill amend <skill-name>
  hybridclaw skill amend <skill-name> --apply
  hybridclaw skill amend <skill-name> --reject
  hybridclaw skill amend <skill-name> --rollback
  hybridclaw skill history <skill-name>
  hybridclaw skill install <skill-name> [install-id]

Notes:
  - \`list\` shows declared install options from skill frontmatter.
  - Omit \`--channel\` to change the global disabled list.
  - \`--channel teams\` is normalized to \`msteams\`.
  - \`inspect\` shows observation-based health metrics for a skill or all observed skills.
  - \`runs\` shows recent execution observations for one skill.
  - \`amend\` stages, applies, rejects, or rolls back skill amendments.
  - \`history\` shows amendment versions for one skill, not execution runs.
  - \`install\` runs one declared installer (brew, uv, npm, go, download).`);
}

function printPluginUsage(): void {
  console.log(`Usage: hybridclaw plugin <command>

Commands:
  hybridclaw plugin list
  hybridclaw plugin install <path|npm-spec>
  hybridclaw plugin uninstall <plugin-id>

Examples:
  hybridclaw plugin list
  hybridclaw plugin install ./plugins/example-plugin
  hybridclaw plugin install @scope/hybridclaw-plugin-example
  hybridclaw plugin uninstall example-plugin

Notes:
  - Plugins install into \`~/.hybridclaw/plugins/<plugin-id>\`.
  - Valid plugins in \`~/.hybridclaw/plugins/\` or \`./.hybridclaw/plugins/\` auto-discover at runtime.
  - \`list\` shows discovered plugin status, source, tools, hooks, and load errors.
  - \`install\` validates \`hybridclaw.plugin.yaml\` and installs npm dependencies when needed.
  - \`uninstall\` removes the home-installed plugin directory and matching \`plugins.list[]\` overrides.
  - Use ${runtimeConfigPath()} only for plugin overrides such as disable flags, config values, or custom paths.`);
}

function printHelpUsage(): void {
  console.log(`Usage: hybridclaw help <topic>

Topics:
  auth        Help for unified provider login/logout/status
  gateway     Help for gateway lifecycle and passthrough commands
  tui         Help for terminal client
  onboarding  Help for onboarding flow
  channels    Help for channel setup helpers
  plugin      Help for plugin management
  msteams     Help for Microsoft Teams auth/setup commands
  openrouter  Help for OpenRouter setup/status/logout commands
  whatsapp    Help for WhatsApp setup/reset commands
  skill       Help for skill installer commands
  update      Help for checking/applying CLI updates
  audit       Help for audit commands
  doctor      Help for diagnostics and auto-remediation
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
    case 'plugin':
      printPluginUsage();
      return true;
    case 'msteams':
    case 'teams':
      printMSTeamsUsage();
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
    case 'doctor':
      printDoctorUsage();
      return true;
    case 'help':
      printHelpUsage();
      return true;
    default:
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
  logRequests = false,
): Promise<void> {
  await ensureRuntimeCredentials({ commandName });
  if (sandboxMode) {
    setSandboxModeOverride(sandboxMode);
  }
  if (logRequests) {
    process.env[GATEWAY_LOG_REQUESTS_ENV] = '1';
    console.warn(GATEWAY_LOG_REQUESTS_WARNING);
  }
  if (debug) {
    process.env.HYBRIDCLAW_FORCE_LOG_LEVEL = 'debug';
    const { forceLoggerLevel } = await import('./logger.js');
    forceLoggerLevel('debug');
    console.log(`${commandName}: forcing gateway log level to debug.`);
  }
  ensureGatewayRunDir();
  const foregroundGatewayPid = registerForegroundGatewayPid(commandName);
  if (process.env[GATEWAY_STDIO_TO_LOG_ENV] === '1') {
    delete process.env[GATEWAY_LOG_FILE_ENV];
  } else {
    process.env[GATEWAY_LOG_FILE_ENV] = GATEWAY_LOG_PATH;
  }
  await ensureRuntimeContainer(commandName, true, sandboxMode);
  try {
    await import('./gateway/gateway.js');
    foregroundGatewayPid.markReady();
  } catch (error) {
    foregroundGatewayPid.cleanup();
    throw error;
  }
}

async function startGatewayBackend(
  commandName: string,
  waitForHealthy = false,
  sandboxMode: SandboxModeOverride | null = null,
  debug = false,
  logRequests = false,
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
  if (logRequests) {
    console.warn(GATEWAY_LOG_REQUESTS_WARNING);
  }

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
    ...(logRequests ? ['--log-requests'] : []),
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
      `\`--${unsupportedLifecycleFlag}\` is only supported with \`hybridclaw gateway start\` and \`hybridclaw gateway restart\`.`,
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
        flags.logRequests,
      );
      return;
    }
    await startGatewayBackend(
      'hybridclaw gateway start',
      false,
      flags.sandboxMode,
      flags.debug,
      flags.logRequests,
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
        flags.logRequests,
      );
      return;
    }
    await startGatewayBackend(
      'hybridclaw gateway restart',
      false,
      flags.sandboxMode,
      flags.debug,
      flags.logRequests,
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

type UnifiedProvider =
  | 'hybridai'
  | 'codex'
  | 'openrouter'
  | 'local'
  | 'msteams';

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
  if (
    normalized === 'msteams' ||
    normalized === 'teams' ||
    normalized === 'ms-teams'
  ) {
    return 'msteams';
  }
  return null;
}

function normalizeArgs(args: string[]): string[] {
  return args.map((arg) => arg.trim()).filter(Boolean);
}

function parseSkillChannelKind(
  value: string,
): SkillConfigChannelKind | undefined {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'global') return undefined;
  const channelKind = normalizeSkillConfigChannelKind(raw);
  if (!channelKind) {
    throw new Error(`Unsupported channel kind: ${value}`);
  }
  return channelKind;
}

function parseSkillScopeArgs(args: string[]): {
  channelKind?: SkillConfigChannelKind;
  remaining: string[];
} {
  const remaining: string[] = [];
  let channelKind: SkillConfigChannelKind | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--channel') {
      const next = args[index + 1];
      if (!next) {
        throw new Error('Missing value for `--channel`.');
      }
      channelKind = parseSkillChannelKind(next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--channel=')) {
      channelKind = parseSkillChannelKind(arg.slice('--channel='.length));
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    remaining.push(arg);
  }

  return { channelKind, remaining };
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
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`local\`, or \`msteams\`.`,
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
        `Unknown provider "${rawProvider}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`local\`, or \`msteams\`.`,
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
  secretKey: 'OPENROUTER_API_KEY' | 'MSTEAMS_APP_PASSWORD',
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

function printMSTeamsStatus(): void {
  ensureRuntimeConfigFile();
  const config = getRuntimeConfig();
  const storedAppPassword = readStoredRuntimeSecret('MSTEAMS_APP_PASSWORD');
  const envAppId = process.env.MSTEAMS_APP_ID?.trim() || '';
  const envTenantId = process.env.MSTEAMS_TENANT_ID?.trim() || '';
  const envAppPassword = process.env.MSTEAMS_APP_PASSWORD?.trim() || '';
  const appPassword = envAppPassword || storedAppPassword || '';
  const source = envAppPassword
    ? storedAppPassword && envAppPassword === storedAppPassword
      ? 'runtime-secrets'
      : 'env'
    : storedAppPassword
      ? 'runtime-secrets'
      : null;
  const appId = envAppId || config.msteams.appId;
  const tenantId = envTenantId || config.msteams.tenantId;

  console.log(`Path: ${runtimeSecretsPath()}`);
  console.log(`Authenticated: ${appId && appPassword ? 'yes' : 'no'}`);
  if (source) {
    console.log(`Source: ${source}`);
  }
  if (appPassword) {
    console.log(`App password: ${maskSecret(appPassword)}`);
  }
  console.log(`Config: ${runtimeConfigPath()}`);
  console.log(`Enabled: ${config.msteams.enabled ? 'yes' : 'no'}`);
  console.log(`App ID: ${appId || '(not set)'}`);
  console.log(`Tenant ID: ${tenantId || '(not set)'}`);
  console.log(`Webhook path: ${config.msteams.webhook.path}`);
  console.log(`DM policy: ${config.msteams.dmPolicy}`);
  console.log(`Group policy: ${config.msteams.groupPolicy}`);
}

function clearMSTeamsCredentials(): void {
  ensureRuntimeConfigFile();
  const filePath = saveRuntimeSecrets({ MSTEAMS_APP_PASSWORD: null });
  delete process.env.MSTEAMS_APP_PASSWORD;
  const nextConfig = updateRuntimeConfig((draft) => {
    draft.msteams.enabled = false;
    draft.msteams.appId = '';
    draft.msteams.tenantId = '';
  });

  console.log(`Cleared Microsoft Teams credentials in ${filePath}.`);
  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(
    `Microsoft Teams integration: ${nextConfig.msteams.enabled ? 'enabled' : 'disabled'}`,
  );
  console.log(
    'If MSTEAMS_APP_ID, MSTEAMS_APP_PASSWORD, or MSTEAMS_TENANT_ID are still exported in your shell, unset them separately.',
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
  if (provider === 'msteams') {
    printMSTeamsUsage();
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
      `Unknown auth login provider "${normalized[0]}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`local\`, or \`msteams\`.`,
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
  if (parsed.provider === 'msteams') {
    await configureMSTeamsAuth(parsed.remaining);
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
  if (provider === 'msteams') {
    if (action === 'status') {
      printMSTeamsStatus();
      return;
    }
    clearMSTeamsCredentials();
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
      `Unknown ${action} provider "${normalized[0]}". Use \`hybridai\`, \`codex\`, \`openrouter\`, \`local\`, or \`msteams\`.`,
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

function parseBooleanFlagValue(flagName: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case '1':
    case 'true':
    case 'yes':
    case 'y':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'n':
    case 'off':
      return false;
    default:
      throw new Error(`Invalid value for \`${flagName}\`: ${raw}`);
  }
}

function parseEmailSetupArgs(args: string[]): {
  address: string | null;
  password: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
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
  let imapSecure: boolean | null = null;
  let smtpHost: string | null = null;
  let smtpPort: number | null = null;
  let smtpSecure: boolean | null = null;
  let pollIntervalMs: number | null = null;
  let textChunkLimit: number | null = null;
  let mediaMaxMb: number | null = null;
  const folders: string[] = [];
  const allowFrom: string[] = [];

  const parseAllowFrom = (raw: string): string => {
    const normalized = normalizeEmailAllowEntry(raw);
    if (!normalized) {
      throw new Error(
        `Invalid email allowlist entry: ${raw}. Use an email address, *@example.com, or *`,
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
    if (arg === '--imap-secure') {
      imapSecure = true;
      continue;
    }
    if (arg === '--no-imap-secure') {
      imapSecure = false;
      continue;
    }
    if (arg.startsWith('--imap-secure=')) {
      imapSecure = parseBooleanFlagValue(
        '--imap-secure',
        arg.slice('--imap-secure='.length),
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
    if (arg === '--smtp-secure') {
      smtpSecure = true;
      continue;
    }
    if (arg === '--no-smtp-secure') {
      smtpSecure = false;
      continue;
    }
    if (arg.startsWith('--smtp-secure=')) {
      smtpSecure = parseBooleanFlagValue(
        '--smtp-secure',
        arg.slice('--smtp-secure='.length),
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
    imapSecure,
    smtpHost,
    smtpPort,
    smtpSecure,
    pollIntervalMs,
    folders: [...new Set(folders.filter(Boolean))],
    allowFrom: [...new Set(allowFrom)],
    textChunkLimit,
    mediaMaxMb,
  };
}

function parseMSTeamsLoginArgs(args: string[]): {
  appId: string | null;
  appPassword: string | null;
  tenantId: string | null;
} {
  let appId: string | null = null;
  let appPassword: string | null = null;
  let tenantId: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--app-id' || arg === '--client-id') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--app-id`.');
      appId = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--app-id=')) {
      appId = arg.slice('--app-id='.length).trim() || null;
      continue;
    }
    if (arg.startsWith('--client-id=')) {
      appId = arg.slice('--client-id='.length).trim() || null;
      continue;
    }
    if (arg === '--app-password' || arg === '--client-secret') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--app-password`.');
      appPassword = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--app-password=')) {
      appPassword = arg.slice('--app-password='.length).trim() || null;
      continue;
    }
    if (arg.startsWith('--client-secret=')) {
      appPassword = arg.slice('--client-secret='.length).trim() || null;
      continue;
    }
    if (arg === '--tenant-id') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value for `--tenant-id`.');
      tenantId = next.trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--tenant-id=')) {
      tenantId = arg.slice('--tenant-id='.length).trim() || null;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    throw new Error(
      `Unexpected argument: ${arg}. Use \`hybridclaw auth login msteams [--app-id <id>] [--app-password <secret>] [--tenant-id <id>]\`.`,
    );
  }

  return {
    appId,
    appPassword,
    tenantId,
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

async function promptOptionalWithDefault(params: {
  rl: readline.Interface;
  question: string;
  defaultValue?: string;
}): Promise<string> {
  const suffix = params.defaultValue ? ` [${params.defaultValue}]` : '';
  const raw = (
    await params.rl.question(`${params.question}${suffix}: `)
  ).trim();
  return raw || params.defaultValue || '';
}

async function resolveInteractiveMSTeamsLogin(params: {
  appId: string;
  appPassword: string;
  tenantId: string;
}): Promise<{
  appId: string;
  appPassword: string;
  tenantId: string;
}> {
  let appId = params.appId;
  let appPassword = params.appPassword;

  if (appId && appPassword) {
    return {
      appId,
      appPassword,
      tenantId: params.tenantId,
    };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Missing Microsoft Teams credentials. Pass `--app-id <id>` and `--app-password <secret>` (or the `--client-id` / `--client-secret` aliases), set `MSTEAMS_APP_PASSWORD`, or run this command in an interactive terminal to be prompted.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    appId = await promptWithDefault({
      rl,
      question: 'Microsoft Teams app id',
      defaultValue: appId || undefined,
    });
    appPassword = await promptWithDefault({
      rl,
      question: 'Microsoft Teams app password',
      defaultValue: appPassword || undefined,
    });
    const tenantId = await promptOptionalWithDefault({
      rl,
      question: 'Microsoft Teams tenant id (optional)',
      defaultValue: params.tenantId || undefined,
    });
    return {
      appId,
      appPassword,
      tenantId,
    };
  } finally {
    rl.close();
  }
}

async function resolveInteractiveEmailSetup(params: {
  address: string;
  allowFrom: string[];
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}): Promise<{
  address: string;
  allowFrom: string[];
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  password: string;
  passwordSource: 'explicit' | 'prompt' | 'env';
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
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
      imapSecure: params.imapSecure,
      password,
      passwordSource,
      smtpHost,
      smtpPort: params.smtpPort,
      smtpSecure: params.smtpSecure,
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
    const imapSecureRaw = await promptWithDefault({
      rl,
      question: 'IMAP secure (TLS on connect)',
      defaultValue: String(params.imapSecure),
      validate: (value) => {
        try {
          return String(parseBooleanFlagValue('--imap-secure', value));
        } catch {
          return null;
        }
      },
      errorMessage: 'Enter true or false for IMAP secure.',
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
    const smtpSecureRaw = await promptWithDefault({
      rl,
      question: 'SMTP secure (TLS on connect)',
      defaultValue: String(params.smtpSecure),
      validate: (value) => {
        try {
          return String(parseBooleanFlagValue('--smtp-secure', value));
        } catch {
          return null;
        }
      },
      errorMessage: 'Enter true or false for SMTP secure.',
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
      imapSecure: parseBooleanFlagValue('--imap-secure', imapSecureRaw),
      password,
      passwordSource,
      smtpHost,
      smtpPort: Number(smtpPortRaw),
      smtpSecure: parseBooleanFlagValue('--smtp-secure', smtpSecureRaw),
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

async function configureMSTeamsAuth(args: string[]): Promise<void> {
  ensureRuntimeConfigFile();
  const parsed = parseMSTeamsLoginArgs(args);
  const currentConfig = getRuntimeConfig().msteams;
  const resolved = await resolveInteractiveMSTeamsLogin({
    appId:
      parsed.appId || process.env.MSTEAMS_APP_ID?.trim() || currentConfig.appId,
    appPassword:
      parsed.appPassword ||
      process.env.MSTEAMS_APP_PASSWORD?.trim() ||
      readStoredRuntimeSecret('MSTEAMS_APP_PASSWORD') ||
      '',
    tenantId:
      parsed.tenantId ??
      process.env.MSTEAMS_TENANT_ID?.trim() ??
      currentConfig.tenantId,
  });

  const nextConfig = updateRuntimeConfig((draft) => {
    draft.msteams.enabled = true;
    draft.msteams.appId = resolved.appId;
    draft.msteams.tenantId = resolved.tenantId;
  });
  const secretsPath = saveRuntimeSecrets({
    MSTEAMS_APP_PASSWORD: resolved.appPassword,
  });
  process.env.MSTEAMS_APP_PASSWORD = resolved.appPassword;

  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Saved Microsoft Teams app password to ${secretsPath}.`);
  console.log('Microsoft Teams mode: enabled');
  console.log(`App ID: ${nextConfig.msteams.appId}`);
  console.log(`Tenant ID: ${nextConfig.msteams.tenantId || '(not set)'}`);
  console.log(`Webhook path: ${nextConfig.msteams.webhook.path}`);
  console.log(`DM policy: ${nextConfig.msteams.dmPolicy}`);
  console.log(`Group policy: ${nextConfig.msteams.groupPolicy}`);
  console.log(
    'Default Teams access is deny-by-default. Add allowed AAD object IDs or channel/team overrides before expecting replies.',
  );
  console.log('Next:');
  console.log('  Restart the gateway to pick up Teams settings:');
  console.log('    hybridclaw gateway restart --foreground');
  console.log('    hybridclaw gateway status');
  console.log(
    `  Expose ${nextConfig.msteams.webhook.path} on your public HTTPS endpoint and register it in the Teams bot channel`,
  );
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
    imapSecure: parsed.imapSecure ?? currentConfig.imapSecure,
    password:
      parsed.password?.trim() || process.env.EMAIL_PASSWORD?.trim() || '',
    smtpHost: parsed.smtpHost || currentConfig.smtpHost,
    smtpPort: parsed.smtpPort || currentConfig.smtpPort,
    smtpSecure: parsed.smtpSecure ?? currentConfig.smtpSecure,
  });

  const nextConfig = updateRuntimeConfig((draft) => {
    draft.email.enabled = true;
    draft.email.address = resolved.address;
    draft.email.imapHost = resolved.imapHost;
    draft.email.imapPort = resolved.imapPort;
    draft.email.imapSecure = resolved.imapSecure;
    draft.email.smtpHost = resolved.smtpHost;
    draft.email.smtpPort = resolved.smtpPort;
    draft.email.smtpSecure = resolved.smtpSecure;
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
  console.log(`IMAP secure: ${nextConfig.email.imapSecure}`);
  console.log(
    `SMTP: ${nextConfig.email.smtpHost}:${nextConfig.email.smtpPort}`,
  );
  console.log(`SMTP secure: ${nextConfig.email.smtpSecure}`);
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

function printSkillMetrics(metrics: SkillHealthMetrics): void {
  const formatRatioAsPercent = (value: number): string =>
    `${(value * 100).toFixed(2)}%`;
  console.log(`Skill: ${metrics.skill_name}`);
  console.log(`Executions: ${metrics.total_executions}`);
  console.log(`Success rate: ${formatRatioAsPercent(metrics.success_rate)}`);
  console.log(`Avg duration: ${Math.round(metrics.avg_duration_ms)}ms`);
  console.log(
    `Tool breakage: ${formatRatioAsPercent(metrics.tool_breakage_rate)}`,
  );
  console.log(`Positive feedback: ${metrics.positive_feedback_count}`);
  console.log(`Negative feedback: ${metrics.negative_feedback_count}`);
  console.log(`Degraded: ${metrics.degraded ? 'yes' : 'no'}`);
  if (metrics.degradation_reasons.length > 0) {
    console.log(`Reasons: ${metrics.degradation_reasons.join('; ')}`);
  }
  if (metrics.error_clusters.length > 0) {
    console.log('Error clusters:');
    for (const cluster of metrics.error_clusters) {
      const sample = cluster.sample_detail ? ` — ${cluster.sample_detail}` : '';
      console.log(`  ${cluster.category}: ${cluster.count}${sample}`);
    }
  }
}

function printAmendmentSummary(amendment: SkillAmendment): void {
  console.log(
    `v${amendment.version} [${amendment.status}] guard=${amendment.guard_verdict}/${amendment.guard_findings_count} runs=${amendment.runs_since_apply}`,
  );
  console.log(`  created: ${amendment.created_at}`);
  if (amendment.reviewed_by) {
    console.log(`  reviewed by: ${amendment.reviewed_by}`);
  }
  if (amendment.rationale) {
    console.log(`  rationale: ${amendment.rationale}`);
  }
  if (amendment.diff_summary) {
    console.log(`  diff: ${amendment.diff_summary}`);
  }
}

function printSkillObservationRun(observation: SkillObservation): void {
  console.log(`Run: ${observation.run_id}`);
  console.log(`Outcome: ${observation.outcome}`);
  console.log(`Observed: ${observation.created_at}`);
  console.log(`Duration: ${observation.duration_ms}ms`);
  console.log(
    `Tools: ${observation.tool_calls_failed}/${observation.tool_calls_attempted} failed`,
  );
  if (observation.feedback_sentiment) {
    console.log(`Feedback: ${observation.feedback_sentiment}`);
  }
  if (observation.user_feedback) {
    console.log(`Feedback note: ${observation.user_feedback}`);
  }
  if (observation.error_category) {
    console.log(`Error category: ${observation.error_category}`);
  }
  if (observation.error_detail) {
    console.log(`Error detail: ${observation.error_detail}`);
  }
}

async function handleSkillCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printSkillUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'list') {
    const { listSkillCatalogEntries } = await import(
      './skills/skills-management.js'
    );
    const catalog = listSkillCatalogEntries();
    for (const skill of catalog) {
      const availability = skill.available
        ? 'available'
        : skill.missing.join(', ');
      console.log(`${skill.name} [${availability}]`);
      for (const install of skill.installs) {
        const label = install.label ? ` — ${install.label}` : '';
        console.log(`  ${install.id} (${install.kind})${label}`);
      }
    }
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const { channelKind, remaining } = parseSkillScopeArgs(normalized.slice(1));
    const skillName = remaining[0];
    if (!skillName || remaining.length !== 1) {
      printSkillUsage();
      throw new Error(
        `Expected exactly one skill name for \`hybridclaw skill ${sub}\`.`,
      );
    }

    const { loadSkillCatalog } = await import('./skills/skills.js');
    const known = loadSkillCatalog().some((skill) => skill.name === skillName);
    if (!known) {
      throw new Error(`Unknown skill: ${skillName}`);
    }

    const enabled = sub === 'enable';
    const nextConfig = updateRuntimeConfig((draft) => {
      setRuntimeSkillScopeEnabled(draft, skillName, enabled, channelKind);
    });
    console.log(
      `${enabled ? 'Enabled' : 'Disabled'} ${skillName} in ${channelKind ?? 'global'} scope.`,
    );
    if (
      channelKind &&
      enabled &&
      getRuntimeSkillScopeDisabledNames(nextConfig).has(skillName)
    ) {
      console.log(`${skillName} remains globally disabled.`);
    }
    return;
  }

  if (sub === 'toggle') {
    const { channelKind, remaining } = parseSkillScopeArgs(normalized.slice(1));
    if (remaining.length > 0) {
      printSkillUsage();
      throw new Error(
        'Unexpected positional arguments for `hybridclaw skill toggle`.',
      );
    }

    const { loadSkillCatalog } = await import('./skills/skills.js');
    const catalog = loadSkillCatalog();
    if (catalog.length === 0) {
      console.log('No skills found.');
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        '`hybridclaw skill toggle` requires an interactive terminal.',
      );
    }

    const currentConfig = getRuntimeConfig();
    const scopeDisabled = getRuntimeSkillScopeDisabledNames(
      currentConfig,
      channelKind,
    );
    const globalDisabled = getRuntimeSkillScopeDisabledNames(currentConfig);
    for (const [index, skill] of catalog.entries()) {
      const marker = scopeDisabled.has(skill.name) ? '[x]' : '[ ]';
      const globalSuffix =
        channelKind &&
        globalDisabled.has(skill.name) &&
        !scopeDisabled.has(skill.name)
          ? ' (globally disabled)'
          : '';
      console.log(`${index + 1}. ${marker} ${skill.name}${globalSuffix}`);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = (
        await rl.question(
          `Toggle which skill number for ${channelKind ?? 'global'} scope? `,
        )
      ).trim();
      if (!answer) {
        console.log('No changes made.');
        return;
      }
      const selection = Number.parseInt(answer, 10);
      if (
        !Number.isInteger(selection) ||
        selection < 1 ||
        selection > catalog.length
      ) {
        throw new Error('Choose a listed skill number.');
      }
      const selected = catalog[selection - 1];
      if (!selected) {
        throw new Error('Choose a listed skill number.');
      }
      const enabled = scopeDisabled.has(selected.name);
      const nextConfig = updateRuntimeConfig((draft) => {
        setRuntimeSkillScopeEnabled(draft, selected.name, enabled, channelKind);
      });
      console.log(
        `${enabled ? 'Enabled' : 'Disabled'} ${selected.name} in ${channelKind ?? 'global'} scope.`,
      );
      if (
        channelKind &&
        enabled &&
        getRuntimeSkillScopeDisabledNames(nextConfig).has(selected.name)
      ) {
        console.log(`${selected.name} remains globally disabled.`);
      }
    } finally {
      rl.close();
    }
    return;
  }

  if (sub === 'inspect') {
    const { inspectObservedSkill, inspectObservedSkills } = await import(
      './skills/skills-management.js'
    );
    const target = normalized[1];
    if (target === '--all') {
      const metricsList = inspectObservedSkills();
      if (metricsList.length === 0) {
        console.log(
          'No observed skills found in the current inspection window.',
        );
        return;
      }
      for (const [index, metrics] of metricsList.entries()) {
        if (index > 0) console.log('');
        printSkillMetrics(metrics);
      }
      return;
    }
    if (!target) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill inspect`.');
    }
    printSkillMetrics(inspectObservedSkill(target));
    return;
  }

  if (sub === 'amend') {
    const skillName = normalized[1];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill amend`.');
    }

    const { DEFAULT_AGENT_ID } = await import('./agents/agent-types.js');
    const { runSkillAmendmentCommand } = await import(
      './skills/skills-management.js'
    );

    const action = normalized.includes('--apply')
      ? 'apply'
      : normalized.includes('--reject')
        ? 'reject'
        : normalized.includes('--rollback')
          ? 'rollback'
          : 'propose';

    const result = await runSkillAmendmentCommand({
      skillName,
      action,
      reviewedBy: 'cli',
      agentId: DEFAULT_AGENT_ID,
      rollbackReason: 'Rollback requested via CLI.',
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    if (result.action === 'applied') {
      console.log(
        `Applied staged amendment v${result.amendment.version} for ${skillName}.`,
      );
      return;
    }
    if (result.action === 'rejected') {
      console.log(
        `Rejected staged amendment v${result.amendment.version} for ${skillName}.`,
      );
      return;
    }
    if (result.action === 'rolled_back') {
      console.log(
        `Rolled back amendment v${result.amendment.version} for ${skillName}.`,
      );
      return;
    }
    console.log(
      `Staged amendment v${result.amendment.version} for ${skillName}.`,
    );
    console.log(
      `Guard: ${result.amendment.guard_verdict} (${result.amendment.guard_findings_count} finding(s))`,
    );
    console.log(`Diff: ${result.amendment.diff_summary}`);
    return;
  }

  if (sub === 'runs') {
    const skillName = normalized[1];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill runs`.');
    }
    const { getSkillExecutionRuns } = await import(
      './skills/skills-management.js'
    );
    const runs = getSkillExecutionRuns(skillName);
    if (runs.length === 0) {
      console.log(`No observations found for ${skillName}.`);
      return;
    }
    for (const [index, observation] of runs.entries()) {
      if (index > 0) console.log('');
      printSkillObservationRun(observation);
    }
    return;
  }

  if (sub === 'history') {
    const skillName = normalized[1];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill history`.');
    }
    const { getSkillAmendmentHistory } = await import(
      './skills/skills-management.js'
    );
    const history = getSkillAmendmentHistory(skillName);
    if (history.length === 0) {
      console.log(`No amendment history found for ${skillName}.`);
      return;
    }
    for (const [index, amendment] of history.entries()) {
      if (index > 0) console.log('');
      printAmendmentSummary(amendment);
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

async function handlePluginCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printPluginUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'list') {
    if (normalized.length !== 1) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin list`.',
      );
    }

    const { ensurePluginManagerInitialized } = await import(
      './plugins/plugin-manager.js'
    );
    const manager = await ensurePluginManagerInitialized();
    console.log(formatPluginSummaryList(manager.listPluginSummary()));
    return;
  }

  if (sub === 'install') {
    const source = normalized[1];
    if (!source) {
      printPluginUsage();
      throw new Error(
        'Missing plugin source for `hybridclaw plugin install <path|npm-spec>`.',
      );
    }
    if (normalized.length !== 2) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin install <path|npm-spec>`.',
      );
    }

    const { installPlugin } = await import('./plugins/plugin-install.js');
    const result = await installPlugin(source);

    if (result.alreadyInstalled) {
      console.log(
        `Plugin ${result.pluginId} is already present at ${result.pluginDir}.`,
      );
    } else {
      console.log(
        `Installed plugin ${result.pluginId} to ${result.pluginDir}.`,
      );
    }
    if (result.dependenciesInstalled) {
      console.log('Installed plugin npm dependencies.');
    }
    console.log(
      `Plugin ${result.pluginId} will auto-discover from ${result.pluginDir}.`,
    );
    if (result.requiresEnv.length > 0) {
      console.log(`Required env vars: ${result.requiresEnv.join(', ')}`);
    }
    if (result.requiredConfigKeys.length > 0) {
      console.log(
        `Add a plugins.list[] override in ${runtimeConfigPath()} to set required config keys: ${result.requiredConfigKeys.join(', ')}`,
      );
    } else {
      console.log(
        `No config entry is required unless you want plugin overrides in ${runtimeConfigPath()}.`,
      );
    }
    console.log('Restart the gateway to load plugin changes:');
    console.log('  hybridclaw gateway restart --foreground');
    console.log('  hybridclaw gateway status');
    return;
  }

  if (sub === 'uninstall') {
    const pluginId = normalized[1];
    if (!pluginId) {
      printPluginUsage();
      throw new Error(
        'Missing plugin id for `hybridclaw plugin uninstall <plugin-id>`.',
      );
    }
    if (normalized.length !== 2) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin uninstall <plugin-id>`.',
      );
    }

    const { uninstallPlugin } = await import('./plugins/plugin-install.js');
    const result = await uninstallPlugin(pluginId);
    if (result.removedPluginDir) {
      console.log(
        `Uninstalled plugin ${result.pluginId} from ${result.pluginDir}.`,
      );
    } else {
      console.log(
        `Removed plugin overrides for ${result.pluginId}; no installed plugin directory was present at ${result.pluginDir}.`,
      );
    }
    if (result.removedConfigOverrides > 0) {
      const label =
        result.removedConfigOverrides === 1 ? 'override' : 'overrides';
      console.log(
        `Removed ${result.removedConfigOverrides} plugins.list[] ${label} from ${runtimeConfigPath()}.`,
      );
    } else {
      console.log(
        `No plugins.list[] overrides were removed from ${runtimeConfigPath()}.`,
      );
    }
    console.log(
      'Restart the gateway to unload plugin changes if it is running:',
    );
    console.log('  hybridclaw gateway restart --foreground');
    console.log('  hybridclaw gateway status');
    return;
  }
  printPluginUsage();
  throw new Error(
    `Unknown plugin subcommand: ${sub}. Use \`hybridclaw plugin list\`, \`hybridclaw plugin install <path|npm-spec>\`, or \`hybridclaw plugin uninstall <plugin-id>\`.`,
  );
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const topLevelResume = parseResumeFlagValue(
    String(argv[0] || '').trim(),
    argv[1],
  );
  if (topLevelResume) {
    const subargs = topLevelResume.consumedNextArg
      ? [argv[0], argv[1]]
      : [argv[0]];
    if (argv.length !== subargs.length) {
      throw new Error(
        `Unexpected CLI option after --resume: ${String(argv[subargs.length] || '').trim()}`,
      );
    }
    await launchTui(subargs);
    return;
  }

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
      await launchTui(subargs);
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
    case 'plugin':
      await handlePluginCommand(subargs);
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
    case 'doctor': {
      if (isHelpRequest(subargs)) {
        printDoctorUsage();
        break;
      }
      const { runDoctorCli } = await import('./doctor.js');
      process.exitCode = await runDoctorCli(subargs);
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
