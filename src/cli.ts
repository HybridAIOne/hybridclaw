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
import { ensureRuntimeCredentials } from './onboarding.js';
import { runtimeSecretsPath } from './security/runtime-secrets.js';
import { printUpdateUsage, runUpdateCommand } from './update.js';

const PACKAGE_NAME = '@hybridaione/hybridclaw';
let cachedInstallRoot: string | null = null;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  gateway    Manage core runtime (start/stop/status) or run gateway commands
  tui        Start terminal adapter (starts gateway automatically when needed)
  onboarding Run interactive auth + trust-model onboarding
  hybridai   Manage HybridAI API-key login/logout/status
  codex      Manage OpenAI Codex OAuth login/logout/status
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
  hybridclaw gateway <discord-style command ...>`);
}

function printTuiUsage(): void {
  console.log(`Usage: hybridclaw tui

Starts the terminal adapter and connects to the running gateway.
If gateway is not running, it is started in backend mode automatically.

Interactive slash commands inside TUI:
  /help   /bots   /bot <id|name>   /model [name]
  /model default [name]
  /rag [on|off]   /info            /clear
  /stop           /exit`);
}

function printOnboardingUsage(): void {
  console.log(`Usage: hybridclaw onboarding

Runs the HybridClaw onboarding flow:
  1) trust-model acceptance
  2) auth provider selection
  3) HybridAI API key setup or OpenAI Codex OAuth login
  4) default model/bot persistence`);
}

function printCodexUsage(): void {
  console.log(`Usage: hybridclaw codex <command>

Commands:
  hybridclaw codex login
  hybridclaw codex login --device-code
  hybridclaw codex login --browser
  hybridclaw codex login --import
  hybridclaw codex logout
  hybridclaw codex status`);
}

function printHybridAIUsage(): void {
  console.log(`Usage: hybridclaw hybridai <command>

Commands:
  hybridclaw hybridai login
  hybridclaw hybridai login --device-code
  hybridclaw hybridai login --browser
  hybridclaw hybridai login --import
  hybridclaw hybridai logout
  hybridclaw hybridai status`);
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

function printHelpUsage(): void {
  console.log(`Usage: hybridclaw help <topic>

Topics:
  gateway     Help for gateway lifecycle and passthrough commands
  tui         Help for terminal client
  onboarding  Help for onboarding flow
  hybridai    Help for HybridAI API-key auth commands
  codex       Help for OpenAI Codex auth commands
  update      Help for checking/applying CLI updates
  audit       Help for audit commands
  help        This help`);
}

function isHelpRequest(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0]?.toLowerCase();
  return first === 'help' || first === '--help' || first === '-h';
}

function printHelpTopic(topic: string): boolean {
  switch (topic.trim().toLowerCase()) {
    case 'gateway':
      printGatewayUsage();
      return true;
    case 'tui':
      printTuiUsage();
      return true;
    case 'onboarding':
      printOnboardingUsage();
      return true;
    case 'hybridai':
      printHybridAIUsage();
      return true;
    case 'codex':
      printCodexUsage();
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
    console.log(`${commandName}: forcing gateway log level to debug.`);
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
    env: process.env,
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
  const normalized = args.map((arg) => arg.trim()).filter(Boolean);
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

async function handleHybridAICommand(args: string[]): Promise<void> {
  const normalized = args.map((arg) => arg.trim()).filter(Boolean);
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
  const normalized = args.map((arg) => arg.trim()).filter(Boolean);
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
    case 'hybridai':
      await handleHybridAICommand(subargs);
      break;
    case 'codex':
      await handleCodexCommand(subargs);
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
          'Hint: Run `hybridclaw codex login` or `hybridclaw onboarding` to refresh OpenAI Codex credentials.',
        );
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`hybridclaw error: ${message}`);
    }
    process.exit(1);
  });
}
