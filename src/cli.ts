#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import readline from 'readline/promises';

import { ensureHybridAICredentials } from './onboarding.js';
import { DATA_DIR, GATEWAY_BASE_URL, MissingRequiredEnvVarError } from './config.js';

async function ensureRuntimeContainer(commandName: string, required = true): Promise<void> {
  const { ensureContainerImageReady } = await import('./container-setup.js');
  await ensureContainerImageReady({
    commandName,
    required,
    cwd: process.cwd(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isGatewayReachable(): Promise<boolean> {
  const { gatewayHealth, gatewayStatus } = await import('./gateway-client.js');
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

  console.log(`${commandName}: Gateway not found. Starting gateway backend at ${GATEWAY_BASE_URL}.`);
  await startGatewayBackend(commandName, true);

  if (!(await isGatewayReachable())) {
    throw new Error(
      `Gateway did not become available at ${GATEWAY_BASE_URL} after startup.`
      + ' Please run `hybridclaw gateway start --foreground` in another terminal and try again.',
    );
  }
}

function formatInstructionDiffLine(file: {
  path: string;
  status: 'ok' | 'modified' | 'missing' | 'untracked';
  expectedHash: string | null;
  actualHash: string | null;
}): string[] {
  if (file.status === 'modified') {
    return [
      `  - modified ${file.path}`,
      `    expected ${file.expectedHash}`,
      `    actual   ${file.actualHash}`,
    ];
  }
  if (file.status === 'missing') {
    return [
      `  - missing  ${file.path}`,
      `    expected ${file.expectedHash}`,
      '    actual   <missing>',
    ];
  }
  return [
    `  - untracked ${file.path}`,
    '    expected <not in baseline>',
    `    actual   ${file.actualHash || '<missing>'}`,
  ];
}

async function ensureTuiInstructionApproval(commandName: string): Promise<void> {
  const {
    approveInstructionBaseline,
    INSTRUCTION_BASELINE_PATH,
    summarizeInstructionIntegrity,
    verifyInstructionBaseline,
  } = await import('./instruction-integrity.js');
  const {
    beginInstructionApprovalAudit,
    completeInstructionApprovalAudit,
  } = await import('./instruction-approval-audit.js');

  const result = verifyInstructionBaseline();
  if (result.ok) return;
  const summary = summarizeInstructionIntegrity(result);
  const auditContext = beginInstructionApprovalAudit({
    sessionId: 'tui:local',
    source: 'tui.startup',
    description: `TUI startup instruction approval required (${summary}).`,
  });

  console.error(`${commandName}: instruction integrity check failed.`);
  if (result.baselineError) {
    console.error(`Instruction baseline is invalid: ${result.baselineError}`);
    console.error(`Baseline path: ${INSTRUCTION_BASELINE_PATH}`);
  } else if (!result.baseline) {
    console.error(`No approved instruction baseline found at ${INSTRUCTION_BASELINE_PATH}.`);
  }

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
      description: `TUI startup blocked: non-interactive instruction approval required (${summary}).`,
    });
    throw new Error(
      'Instruction files are not approved. Run `hybridclaw audit instructions --approve` and try again.',
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer = '';
  try {
    answer = (await rl.question('Approve current instruction changes now? [y/N] ')).trim().toLowerCase();
  } finally {
    rl.close();
  }

  if (answer !== 'y' && answer !== 'yes') {
    completeInstructionApprovalAudit({
      context: auditContext,
      approved: false,
      approvedBy: 'local-user',
      method: 'interactive',
      description: `User declined TUI instruction approval (${summary}).`,
    });
    throw new Error(
      'Instruction approval required. Run `hybridclaw audit instructions --approve` and restart TUI.',
    );
  }

  try {
    const baseline = approveInstructionBaseline();
    console.log(`Approved instruction baseline at ${INSTRUCTION_BASELINE_PATH} (${baseline.approvedAt}).`);
    completeInstructionApprovalAudit({
      context: auditContext,
      approved: true,
      approvedBy: 'local-user',
      method: 'interactive',
      description: `User approved TUI instruction update (${baseline.approvedAt}).`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    completeInstructionApprovalAudit({
      context: auditContext,
      approved: false,
      approvedBy: 'local-user',
      method: 'interactive',
      description: `TUI instruction approval failed (${message}).`,
    });
    throw err;
  }
}

function printMainUsage(): void {
  console.log(`Usage: hybridclaw <command>

  Commands:
  gateway    Manage core runtime (start/stop/status) or run gateway commands
  tui        Start terminal adapter (starts gateway automatically when needed)
  onboarding Run HybridAI account/API key onboarding
  audit      Inspect/verify structured audit trail
  help       Show general or topic-specific help (e.g. \`hybridclaw help gateway\`)`);
}

function printGatewayUsage(): void {
  console.log(`Usage: hybridclaw gateway <subcommand>

Commands:
  hybridclaw gateway
  hybridclaw gateway start [--foreground]
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
  /help   /bots   /bot <id|name>   /rag [on|off]
  /info   /clear  /stop            /exit`);
}

function printOnboardingUsage(): void {
  console.log(`Usage: hybridclaw onboarding

Runs the HybridAI onboarding flow:
  1) trust-model acceptance
  2) account/login guidance
  3) API key capture/validation
  4) default bot selection and persistence`);
}

function printAuditUsage(): void {
  console.log(`Usage: hybridclaw audit <command>

Commands:
  recent [n]                         Show recent structured audit entries
  recent session <sessionId> [n]     Show recent events for one session
  search <query> [n]                 Search structured audit events
  approvals [n] [--denied]           Show approval decisions
  verify <sessionId>                 Verify wire hash chain integrity
  instructions [--approve]           Verify or approve instruction markdown SHA-256 hashes`);
}

function printHelpUsage(): void {
  console.log(`Usage: hybridclaw help <topic>

Topics:
  gateway     Help for gateway lifecycle and passthrough commands
  tui         Help for terminal client
  onboarding  Help for onboarding flow
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
    if (!parsed || typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      command: Array.isArray(parsed.command) ? parsed.command.map((item) => String(item)) : [],
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

async function runGatewayForeground(commandName: string): Promise<void> {
  await ensureHybridAICredentials({ commandName });
  await ensureRuntimeContainer(commandName);
  await import('./gateway.js');
}

async function startGatewayBackend(commandName: string, waitForHealthy = false): Promise<void> {
  if (await isGatewayReachable()) {
    const existing = readGatewayPid();
    if (existing && isPidRunning(existing.pid)) {
      console.log(`Gateway already running in backend mode (pid ${existing.pid}).`);
    } else {
      console.log(`Gateway already reachable at ${GATEWAY_BASE_URL} (unmanaged by CLI PID file).`);
    }
    return;
  }

  const existing = readGatewayPid();
  if (existing && isPidRunning(existing.pid)) {
    if (waitForHealthy && !(await isGatewayReachable())) {
      const healthy = await waitForGatewayReachable(15_000);
      if (!healthy) {
        throw new Error(
          `Gateway process ${existing.pid} exists but did not become reachable at ${GATEWAY_BASE_URL}.`
          + ` Check logs: ${GATEWAY_LOG_PATH}`,
        );
      }
    }
    console.log(`Gateway already running in backend mode (pid ${existing.pid}).`);
    return;
  }
  if (existing && !isPidRunning(existing.pid)) {
    removeGatewayPidFile();
  }

  await ensureHybridAICredentials({ commandName });
  await ensureRuntimeContainer(commandName);

  ensureGatewayRunDir();
  const out = fs.openSync(GATEWAY_LOG_PATH, 'a');
  const err = fs.openSync(GATEWAY_LOG_PATH, 'a');
  const cliEntry = process.argv[1];
  const childArgs = [cliEntry, 'gateway', 'start', '--foreground'];
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
        `Gateway backend started (pid ${child.pid}) but not reachable at ${GATEWAY_BASE_URL}.`
        + ` Check logs: ${GATEWAY_LOG_PATH}`,
      );
    }
  }

  console.log(`Gateway started in backend mode (pid ${child.pid}).`);
  console.log(`Logs: ${GATEWAY_LOG_PATH}`);
}

async function stopGatewayBackend(): Promise<void> {
  const state = readGatewayPid();
  if (!state) {
    if (await isGatewayReachable()) {
      console.log('Gateway is reachable but no managed PID file was found.');
      console.log('Stop it from its owning process or use your system process manager.');
      return;
    }
    console.log('Gateway is not running (no PID file).');
    return;
  }

  if (!isPidRunning(state.pid)) {
    removeGatewayPidFile();
    console.log(`Removed stale gateway PID file (pid ${state.pid} not running).`);
    return;
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    removeGatewayPidFile();
    throw new Error(`Failed to stop gateway pid ${state.pid}: ${err instanceof Error ? err.message : String(err)}`);
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

async function printGatewayLifecycleStatus(): Promise<void> {
  const state = readGatewayPid();
  const runningByPid = Boolean(state && isPidRunning(state.pid));
  const reachable = await isGatewayReachable();

  if (runningByPid) {
    console.log(`PID file: running (pid ${state!.pid})`);
  } else if (state) {
    console.log(`PID file: stale (pid ${state.pid})`);
  } else {
    console.log('PID file: not found');
  }
  console.log(`Gateway API reachable: ${reachable ? 'yes' : 'no'} (${GATEWAY_BASE_URL})`);

  if (reachable) {
    try {
      const { gatewayStatus } = await import('./gateway-client.js');
      const status = await gatewayStatus();
      console.log(`Uptime: ${status.uptime}s | Sessions: ${status.sessions} | Containers: ${status.activeContainers}`);
    } catch (err) {
      console.log(`Gateway status fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function runGatewayApiCommand(args: string[]): Promise<void> {
  const { gatewayCommand, renderGatewayCommand } = await import('./gateway-client.js');
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

function parseGatewayFlags(args: string[]): { foreground: boolean } {
  return {
    foreground: args.includes('--foreground') || args.includes('-f'),
  };
}

async function handleGatewayCommand(args: string[]): Promise<void> {
  const normalized = args.map((arg) => arg.trim()).filter(Boolean);
  if (normalized.length === 0) {
    await startGatewayBackend('hybridclaw gateway');
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printGatewayUsage();
    return;
  }

  if (sub === 'start') {
    const flags = parseGatewayFlags(normalized.slice(1));
    if (flags.foreground) {
      await runGatewayForeground('hybridclaw gateway start --foreground');
      return;
    }
    await startGatewayBackend('hybridclaw gateway start');
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

async function main(): Promise<void> {
  const command = process.argv[2];
  const subargs = process.argv.slice(3);

  switch (command) {
    case 'gateway':
      await handleGatewayCommand(subargs);
      break;
    case 'tui':
      if (isHelpRequest(subargs)) {
        printTuiUsage();
        break;
      }
      await ensureTuiInstructionApproval('hybridclaw tui');
      await ensureHybridAICredentials({ commandName: 'hybridclaw tui' });
      await ensureRuntimeContainer('hybridclaw tui');
      await ensureGatewayForTui('hybridclaw tui');
      await import('./tui.js');
      break;
    case 'onboarding':
      if (isHelpRequest(subargs)) {
        printOnboardingUsage();
        break;
      }
      await ensureHybridAICredentials({ force: true, commandName: 'hybridclaw onboarding' });
      await ensureRuntimeContainer('hybridclaw onboarding', false);
      break;
    case 'audit': {
      if (isHelpRequest(subargs)) {
        printAuditUsage();
        break;
      }
      const { runAuditCli } = await import('./audit-cli.js');
      await runAuditCli(process.argv.slice(3));
      break;
    }
    case 'help': {
      const topic = (process.argv[3] || '').trim().toLowerCase();
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

const envVarHint: Record<string, string> = {
  HYBRIDAI_API_KEY:
    'Set HYBRIDAI_API_KEY in .env or your shell, then run the command again. You can also run `hybridclaw onboarding` to set it interactively.',
};

function printMissingEnvVarError(message: string, envVar?: string): void {
  const hint = envVar ? envVarHint[envVar] : 'Set this variable and rerun the command.';
  console.error(`hybridclaw error: ${message}`);
  console.error(`Hint: ${hint}`);
  console.error('Make sure you run `hybridclaw` from the directory that contains your .env file.');
}

main().catch((err) => {
  const missingEnvVarMatch = err instanceof Error
    ? err.message.match(/^Missing required env var:\s*([A-Za-z0-9_]+)/)
    : null;
  if (missingEnvVarMatch) {
    printMissingEnvVarError(err.message, missingEnvVarMatch[1]);
  } else if (err instanceof MissingRequiredEnvVarError) {
    printMissingEnvVarError(err.message, err.envVar);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`hybridclaw error: ${message}`);
  }
  process.exit(1);
});
