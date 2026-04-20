#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { makeLazyApi, normalizeArgs } from './cli/common.js';
import {
  isHelpRequest,
  printAcpUsage,
  printAuditUsage,
  printBrowserUsage,
  printDeprecatedProviderAliasWarning,
  printDoctorUsage,
  printEvalUsage,
  printGatewayUsage,
  printHelpTopic,
  printHelpUsage,
  printMainUsage,
  printMigrationUsage,
  printOnboardingUsage,
  printPolicyUsage,
  printTuiUsage,
} from './cli/help.js';
import { ensureOnboardingApi } from './cli/onboarding-api.js';
import {
  findUnsupportedGatewayLifecycleFlag,
  parseGatewayFlags,
  type SandboxModeOverride,
} from './config/cli-flags.js';
import {
  clearRuntimeConfigRevisions,
  deleteRuntimeConfigRevision,
  getRuntimeConfig,
  getRuntimeConfigRevision,
  isContainerSandboxModeExplicit,
  listRuntimeConfigRevisions,
  reloadRuntimeConfig,
  restoreRuntimeConfigRevision,
  runtimeConfigPath,
  runtimeConfigRevisionPath,
  updateRuntimeConfig,
} from './config/runtime-config.js';
import {
  parseRuntimeConfigCommandValue,
  setRuntimeConfigValueAtPath,
} from './config/runtime-config-edit.js';
import { checkConfigFile } from './doctor/checks/config.js';
import { summarizeCounts } from './doctor/utils.js';
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
import { runtimeSecretsPath } from './security/runtime-secrets.js';
import { sleep } from './utils/sleep.js';

const GATEWAY_LOG_REQUESTS_WARNING =
  'Gateway request logging enabled. request_log stores best-effort redacted prompts, responses, and tool payloads for debugging. Treat this log as potentially sensitive.';
const PACKAGE_NAME = '@hybridaione/hybridclaw';
let cachedInstallRoot: string | null = null;
let foregroundGatewayExitHandler: (() => void) | null = null;
let foregroundGatewaySigintHandler: (() => void) | null = null;
let foregroundGatewaySigtermHandler: (() => void) | null = null;
type ConfigApi = typeof import('./config/config.js');

let cachedAppVersion: string | null = null;
const configApiState = makeLazyApi<ConfigApi>(
  () => import('./config/config.js'),
  'Config API accessed before it was initialized. Call ensureConfigApi() first, for example await ensureConfigApi() before calling getGatewayBaseUrl().',
);

function readVersionFromPackageJson(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // fall through
  }
  return null;
}

function resolveCliVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;
  const envVersion = process.env.npm_package_version;
  if (envVersion?.trim()) {
    cachedAppVersion = envVersion.trim();
    return cachedAppVersion;
  }

  const modulePath = fileURLToPath(import.meta.url);
  const moduleVersion = readVersionFromPackageJson(
    path.join(path.dirname(modulePath), '..', 'package.json'),
  );
  if (moduleVersion) {
    cachedAppVersion = moduleVersion;
    return cachedAppVersion;
  }

  const entryPath = process.argv[1];
  if (entryPath) {
    const entryVersion = readVersionFromPackageJson(
      path.join(path.dirname(path.resolve(entryPath)), '..', 'package.json'),
    );
    if (entryVersion) {
      cachedAppVersion = entryVersion;
      return cachedAppVersion;
    }
  }

  const cwdVersion = readVersionFromPackageJson(
    path.join(process.cwd(), 'package.json'),
  );
  cachedAppVersion = cwdVersion || '0.0.0';
  return cachedAppVersion;
}

async function ensureConfigApi(): Promise<ConfigApi> {
  return configApiState.ensure();
}

function getConfigApi(): ConfigApi {
  return configApiState.get();
}

function getGatewayBaseUrl(): string {
  return getConfigApi().GATEWAY_BASE_URL;
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
    return new URL(getGatewayBaseUrl());
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
  const { getResolvedSandboxMode } = await ensureConfigApi();
  if ((sandboxMode || getResolvedSandboxMode()) === 'host') {
    const { ensureHostRuntimeReady } = await import(
      './infra/host-runtime-setup.js'
    );
    ensureHostRuntimeReady({
      commandName,
      required,
      installRoot: resolveInstallRoot(),
    });
    return;
  }
  const { ensureContainerImageReady } = await import(
    './infra/container-setup.js'
  );
  try {
    await ensureContainerImageReady({
      commandName,
      required,
      cwd: resolveInstallRoot(),
    });
  } catch (error) {
    if (
      sandboxMode == null &&
      !isContainerSandboxModeExplicit() &&
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      error instanceof Error &&
      error.name === 'DockerAccessError' &&
      ((error as Error & { kind?: string }).kind === 'missing' ||
        (error as Error & { kind?: string }).kind === 'permission-denied')
    ) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const prompt =
          (error as Error & { kind?: string }).kind === 'missing'
            ? 'Docker is not available, and this install is still using the default container sandbox. Switch HybridClaw to host mode in the runtime config and continue? [Y/n] '
            : 'Docker is installed, but this user cannot access the Docker daemon. Switch HybridClaw to host mode in the runtime config and continue? [Y/n] ';
        const answer = (await rl.question(prompt)).trim().toLowerCase();
        const shouldSwitch = !answer || answer === 'y' || answer === 'yes';
        if (shouldSwitch) {
          updateRuntimeConfig((draft) => {
            draft.container.sandboxMode = 'host';
          });
          console.log(
            `${commandName}: Updated runtime config at ${runtimeConfigPath()}. Continuing in host mode.`,
          );
          return;
        }
      } finally {
        rl.close();
      }
    }
    throw error;
  }
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
  await ensureConfigApi();
  if (await isGatewayReachable()) {
    console.log(`${commandName}: Gateway found at ${getGatewayBaseUrl()}.`);
    return;
  }

  console.log(
    `${commandName}: Gateway not found. Starting gateway backend at ${getGatewayBaseUrl()}.`,
  );
  await startGatewayBackend(commandName, true);

  if (!(await isGatewayReachable())) {
    throw new Error(
      `Gateway did not become available at ${getGatewayBaseUrl()} after startup.` +
        ' Please run `hybridclaw gateway start --foreground` in another terminal and try again.',
    );
  }
}

async function resolveTuiPreflightSandboxMode(): Promise<SandboxModeOverride | null> {
  const { gatewayStatus } = await import('./gateway/gateway-client.js');

  try {
    const status = await gatewayStatus();
    const runtimeSandboxMode = status.sandbox?.mode;
    if (runtimeSandboxMode === 'host') {
      return runtimeSandboxMode;
    }
  } catch {
    // Fall back to the local runtime config when the gateway is not reachable.
  }

  return null;
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

  const { ensureRuntimeCredentials } = await ensureOnboardingApi();
  const { resolveTuiRunOptions } = await import('./tui-session.js');
  const options = resolveTuiRunOptions({
    resumeSessionId: parsed.resumeSessionId,
    resumeCommand: 'hybridclaw tui --resume',
  });
  await ensureRuntimeCredentials({
    commandName: 'hybridclaw tui',
    requireCredentials: false,
  });
  await ensureRuntimeContainer(
    'hybridclaw tui',
    true,
    await resolveTuiPreflightSandboxMode(),
  );
  await ensureTuiInstructionApproval('hybridclaw tui', options.sessionId);
  await ensureGatewayForTui('hybridclaw tui');
  const { runTui } = await import('./tui.js');
  await runTui(options);
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
  const [{ setSandboxModeOverride }, { ensureRuntimeCredentials }] =
    await Promise.all([ensureConfigApi(), ensureOnboardingApi()]);
  await ensureRuntimeCredentials({
    commandName,
    requireCredentials: false,
  });
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
  await ensureConfigApi();
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
          `Gateway already reachable at ${getGatewayBaseUrl()}; adopted pid ${adoptedState?.pid || '(unknown)'}.`,
        );
      } else {
        console.log(
          `Gateway already reachable at ${getGatewayBaseUrl()} (unmanaged by CLI PID file).`,
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
          `Gateway process ${existing.pid} exists but did not become reachable at ${getGatewayBaseUrl()}.` +
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

  const { ensureRuntimeCredentials } = await ensureOnboardingApi();
  await ensureRuntimeCredentials({
    commandName,
    requireCredentials: false,
  });
  await ensureRuntimeContainer(commandName, true, sandboxMode);
  if (logRequests) {
    console.warn(GATEWAY_LOG_REQUESTS_WARNING);
  }

  ensureGatewayRunDir();
  const logFd = fs.openSync(GATEWAY_LOG_PATH, 'a');
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
  const child = spawn(process.execPath, [...process.execArgv, ...childArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: process.cwd(),
    env: {
      ...process.env,
      [GATEWAY_STDIO_TO_LOG_ENV]: '1',
    },
  });
  fs.closeSync(logFd);
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
        `Gateway backend started (pid ${child.pid}) but not reachable at ${getGatewayBaseUrl()}.` +
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
        `Gateway remained reachable at ${getGatewayBaseUrl()} after shutdown request.` +
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
    `Gateway shutdown endpoint is unavailable at ${getGatewayBaseUrl()} and PID ownership could not be recovered.` +
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
    `Gateway API reachable: ${reachable ? 'yes' : 'no'} (${getGatewayBaseUrl()})`,
  );

  if (reachable) {
    try {
      const { gatewayStatus } = await import('./gateway/gateway-client.js');
      const status = await gatewayStatus();
      console.log(
        `Uptime: ${status.uptime}s | Sessions: ${status.sessions} | Sandbox: ${status.sandbox?.mode || 'container'} (${status.sandbox?.activeSessions ?? status.activeContainers} active)`,
      );
      if ((status.sandbox?.activeSessionIds?.length || 0) > 0) {
        console.log('Active sandbox sessions:');
        for (const sessionId of status.sandbox?.activeSessionIds || []) {
          console.log(`  - ${sessionId}`);
        }
      }
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

  await ensureConfigApi();

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

  if (sub === 'eval') {
    console.error('Use top-level eval commands: `hybridclaw eval ...`');
    process.exitCode = 1;
    return;
  }

  await runGatewayApiCommand(normalized);
}

async function handleEvalCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printEvalUsage();
    return;
  }

  const { initDatabase, isDatabaseInitialized } = await import(
    './memory/db.js'
  );
  const { initAgentRegistry } = await import('./agents/agent-registry.js');
  const { handleGatewayCommand, renderGatewayCommand } = await import(
    './gateway/gateway-service.js'
  );

  if (!isDatabaseInitialized()) {
    initDatabase({ quiet: true });
  }
  initAgentRegistry(getRuntimeConfig().agents);

  const result = await handleGatewayCommand({
    sessionId: 'cli:eval',
    guildId: null,
    channelId: 'cli',
    args: ['eval', ...normalized],
  });

  const rendered = renderGatewayCommand(result).trim();
  if (rendered) console.log(rendered);
  if (result.kind === 'error') process.exitCode = 1;
}

async function handleConfigCommand(args: string[]): Promise<void> {
  function parseRevisionId(raw: string): number {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid revision id: ${raw}`);
    }
    return parsed;
  }

  async function runRuntimeConfigFileCheck(): Promise<'ok' | 'warn' | 'error'> {
    const results = await checkConfigFile();
    const summary = summarizeCounts(results);
    for (const result of results) {
      const symbol =
        result.severity === 'ok' ? '✓' : result.severity === 'warn' ? '⚠' : '✖';
      console.log(`${symbol} ${result.label}  ${result.message}`);
    }
    console.log(
      `${summary.ok} ok · ${summary.warn} warning${summary.warn === 1 ? '' : 's'} · ${summary.error} error${summary.error === 1 ? '' : 's'}`,
    );
    const severity =
      summary.error > 0 ? 'error' : summary.warn > 0 ? 'warn' : 'ok';
    process.exitCode = severity === 'error' ? 1 : 0;
    return severity;
  }

  const normalized = normalizeArgs(args);
  if (normalized.length === 0) {
    console.log(`Active config: ${runtimeConfigPath()}`);
    console.log(JSON.stringify(getRuntimeConfig(), null, 2));
    return;
  }

  if (isHelpRequest(normalized)) {
    const { printConfigUsage } = await import('./cli/help.js');
    printConfigUsage();
    return;
  }

  const sub = (normalized[0] || '').trim().toLowerCase();
  if (sub === 'check') {
    await runRuntimeConfigFileCheck();
    return;
  }
  if (sub === 'revisions') {
    const action = (normalized[1] || 'list').trim().toLowerCase();
    if (!action || action === 'list') {
      const revisions = listRuntimeConfigRevisions();
      console.log(`Active config: ${runtimeConfigPath()}`);
      console.log(`Revision store: ${runtimeConfigRevisionPath()}`);
      if (revisions.length === 0) {
        console.log('No config revisions saved yet.');
        return;
      }
      for (const revision of revisions) {
        console.log(
          [
            `#${revision.id}`,
            revision.createdAt,
            `actor=${revision.actor}`,
            `route=${revision.route}`,
            `source=${revision.source}`,
            `md5=${revision.md5}`,
            `bytes=${revision.byteLength}`,
          ].join(' | '),
        );
      }
      return;
    }

    if (action === 'rollback') {
      const revisionId = parseRevisionId(String(normalized[2] || '').trim());
      const revision = getRuntimeConfigRevision(revisionId);
      if (!revision) {
        throw new Error(`Config revision ${revisionId} was not found.`);
      }
      const nextConfig = restoreRuntimeConfigRevision(revisionId, {
        route: `cli.config.revisions.rollback#${revisionId}`,
        source: 'internal',
      });
      console.log(`Rolled back runtime config to revision #${revisionId}.`);
      console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
      console.log(`Revision store: ${runtimeConfigRevisionPath()}`);
      console.log(JSON.stringify(nextConfig, null, 2));
      await runRuntimeConfigFileCheck();
      return;
    }

    if (action === 'delete') {
      const revisionId = parseRevisionId(String(normalized[2] || '').trim());
      const deleted = deleteRuntimeConfigRevision(revisionId);
      if (!deleted) {
        throw new Error(`Config revision ${revisionId} was not found.`);
      }
      console.log(`Deleted config revision #${revisionId}.`);
      console.log(`Revision store: ${runtimeConfigRevisionPath()}`);
      return;
    }

    if (action === 'clear') {
      const cleared = clearRuntimeConfigRevisions();
      console.log(
        `Cleared ${cleared} config revision${cleared === 1 ? '' : 's'}.`,
      );
      console.log(`Revision store: ${runtimeConfigRevisionPath()}`);
      return;
    }

    throw new Error(
      'Unknown config revisions subcommand. Use `hybridclaw config revisions`, `hybridclaw config revisions rollback <id>`, `hybridclaw config revisions delete <id>`, or `hybridclaw config revisions clear`.',
    );
  }
  if (sub === 'reload') {
    const nextConfig = reloadRuntimeConfig('cli');
    console.log(`Reloaded runtime config from ${runtimeConfigPath()}.`);
    console.log(JSON.stringify(nextConfig, null, 2));
    await runRuntimeConfigFileCheck();
    return;
  }
  if (sub !== 'set') {
    throw new Error(
      'Unknown config subcommand. Use `hybridclaw config`, `hybridclaw config check`, `hybridclaw config reload`, `hybridclaw config set <key> <value>`, or `hybridclaw config revisions`.',
    );
  }

  const key = String(normalized[1] || '').trim();
  const rawValue = normalized.slice(2).join(' ').trim();
  if (!key || !rawValue) {
    throw new Error(
      'Usage: `hybridclaw config`, `hybridclaw config check`, `hybridclaw config reload`, `hybridclaw config set <key> <value>`, or `hybridclaw config revisions`',
    );
  }

  const value = parseRuntimeConfigCommandValue(rawValue);
  const nextConfig = updateRuntimeConfig(
    (draft) => {
      setRuntimeConfigValueAtPath(draft, key, value);
    },
    {
      route: `cli.config.set:${key}`,
      source: 'internal',
    },
  );
  console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
  console.log(`Key: ${key}`);
  console.log(JSON.stringify(nextConfig, null, 2));
  await runRuntimeConfigFileCheck();
}

async function handlePolicyCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (isHelpRequest(normalized)) {
    printPolicyUsage();
    return;
  }
  const policyCli = await import('./policy/policy-cli.js');
  await policyCli.handlePolicyCommand(normalized);
}

async function handleLocalCommand(args: string[]): Promise<void> {
  const cliAuth = await import('./cli/auth-command.js');
  await cliAuth.handleLocalCommand(args);
}

async function handleAuthCommand(args: string[]): Promise<void> {
  const cliAuth = await import('./cli/auth-command.js');
  await cliAuth.handleAuthCommand(args);
}

async function handleChannelsCommand(args: string[]): Promise<void> {
  const cliChannels = await import('./cli/channels-command.js');
  await cliChannels.handleChannelsCommand(args);
}

async function handleBrowserCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printBrowserUsage();
    return;
  }

  const { getBrowserProfileDir, launchBrowserLogin } = await import(
    './browser/browser-login.js'
  );
  const { DATA_DIR } = await import('./config/config.js');
  const profileDir = getBrowserProfileDir(DATA_DIR);

  const sub = normalized[0].toLowerCase();

  if (sub === 'login') {
    let url = 'https://accounts.google.com';
    for (let i = 1; i < normalized.length; i++) {
      if (normalized[i] === '--url' && normalized[i + 1]) {
        url = normalized[++i];
      }
    }

    console.log(`Opening browser with persistent profile...`);
    console.log(`Profile directory: ${profileDir}`);
    console.log(`Starting URL: ${url}`);
    console.log('');
    console.log(
      'Log into any sites you want the agent to access, then close the browser.',
    );
    console.log('Your sessions will be saved automatically.');
    console.log('');

    const child = await launchBrowserLogin(profileDir, { url });
    await new Promise<void>((resolve) => {
      child.on('close', () => {
        console.log('');
        console.log('Browser closed. Sessions saved.');
        console.log(
          'The agent will reuse these sessions for browser automation.',
        );
        resolve();
      });
      child.on('error', (err) => {
        console.error(`Browser failed to launch: ${err.message}`);
        resolve();
      });
    });
    return;
  }

  if (sub === 'status') {
    if (fs.existsSync(profileDir)) {
      const entries = fs.readdirSync(profileDir);
      const hasProfile = entries.length > 0;
      console.log(`Profile directory: ${profileDir}`);
      console.log(`Profile exists: ${hasProfile ? 'yes' : 'no (empty)'}`);
      if (hasProfile) {
        const cookiesPath = path.join(profileDir, 'Default', 'Cookies');
        const hasCookies = fs.existsSync(cookiesPath);
        console.log(`Has cookies: ${hasCookies ? 'yes' : 'no'}`);
      }
    } else {
      console.log(`Profile directory: ${profileDir}`);
      console.log(
        'No browser profile found. Run `hybridclaw browser login` to create one.',
      );
    }
    return;
  }

  if (sub === 'reset') {
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true });
      console.log(`Deleted browser profile at ${profileDir}.`);
      console.log('Run `hybridclaw browser login` to create a fresh profile.');
    } else {
      console.log('No browser profile to reset.');
    }
    return;
  }

  throw new Error(
    `Unknown browser subcommand: ${sub}. Use \`login\`, \`status\`, or \`reset\`.`,
  );
}

async function handleHybridAICommand(args: string[]): Promise<void> {
  const cliAuth = await import('./cli/auth-command.js');
  await cliAuth.handleHybridAICommand(args);
}

async function handleCodexCommand(args: string[]): Promise<void> {
  const cliAuth = await import('./cli/auth-command.js');
  await cliAuth.handleCodexCommand(args);
}

async function handleSkillCommand(args: string[]): Promise<void> {
  const cliSkill = await import('./cli/skill-command.js');
  await cliSkill.handleSkillCommand(args);
}

async function handleToolCommand(args: string[]): Promise<void> {
  const cliTool = await import('./cli/tool-command.js');
  await cliTool.handleToolCommand(args);
}

async function handleSecretCommand(args: string[]): Promise<void> {
  const cliSecret = await import('./cli/secret-command.js');
  await cliSecret.handleSecretCommand(args);
}

async function handlePluginCommand(args: string[]): Promise<void> {
  const cliPlugin = await import('./cli/plugin-command.js');
  await cliPlugin.handlePluginCommand(args);
}

async function handleAgentMigrationCommand(
  sourceKind: 'openclaw' | 'hermes',
  args: string[],
): Promise<void> {
  const cliMigration = await import('./cli/agent-migration-command.js');
  await cliMigration.handleAgentMigrationCommand(sourceKind, args);
}

async function handleMigrateCommand(args: string[]): Promise<void> {
  const cliMigration = await import('./cli/agent-migration-command.js');
  const subcommand = (args[0] || '').trim().toLowerCase();
  if (!subcommand || isHelpRequest(args)) {
    printMigrationUsage();
    return;
  }
  if (subcommand === 'openclaw' || subcommand === 'hermes') {
    await cliMigration.handleAgentMigrationCommand(subcommand, args.slice(1));
    return;
  }
  throw new Error(
    `Unknown migration source: ${subcommand}. Use \`hybridclaw migrate openclaw\` or \`hybridclaw migrate hermes\`.`,
  );
}

async function handleAgentPackageCommand(args: string[]): Promise<void> {
  const cliAgent = await import('./cli/agent-command.js');
  await cliAgent.handleAgentPackageCommand(args);
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
      console.log(resolveCliVersion());
      break;
    case 'agent':
      await handleAgentPackageCommand(subargs);
      break;
    case 'auth':
      await handleAuthCommand(subargs);
      break;
    case 'config':
      await handleConfigCommand(subargs);
      break;
    case 'secret':
      await handleSecretCommand(subargs);
      break;
    case 'policy':
      await handlePolicyCommand(subargs);
      break;
    case 'gateway':
      await handleGatewayCommand(subargs);
      break;
    case 'acp': {
      if (isHelpRequest(subargs)) {
        printAcpUsage();
        break;
      }
      process.env.HYBRIDCLAW_STDIO_PROTOCOL = 'acp';
      const { runAcpServer } = await import('./acp/server.js');
      await runAcpServer();
      break;
    }
    case '__gateway-restart-helper': {
      const payload = String(subargs[0] || '').trim();
      if (!payload) {
        throw new Error('Missing gateway restart helper payload.');
      }
      const { runGatewayRestartHelperFromArg } = await import(
        './gateway/gateway-restart.js'
      );
      await runGatewayRestartHelperFromArg(payload);
      break;
    }
    case 'eval':
      await handleEvalCommand(subargs);
      break;
    case '__eval-terminal-bench-native': {
      const { initDatabase, isDatabaseInitialized } = await import(
        './memory/db.js'
      );
      const { initAgentRegistry } = await import('./agents/agent-registry.js');
      const { runTerminalBenchNativeCli } = await import(
        './evals/terminal-bench-native.js'
      );
      if (!isDatabaseInitialized()) {
        initDatabase({ quiet: true });
      }
      initAgentRegistry(getRuntimeConfig().agents);
      await runTerminalBenchNativeCli(subargs);
      break;
    }
    case '__eval-locomo-native': {
      const { runLocomoNativeCli } = await import('./evals/locomo-native.js');
      await runLocomoNativeCli(subargs);
      break;
    }
    case 'tui':
      await launchTui(subargs);
      break;
    case 'onboarding': {
      if (isHelpRequest(subargs)) {
        printOnboardingUsage();
        break;
      }
      const { ensureRuntimeCredentials } = await ensureOnboardingApi();
      await ensureRuntimeCredentials({
        force: true,
        commandName: 'hybridclaw onboarding',
      });
      await ensureRuntimeContainer('hybridclaw onboarding', false);
      break;
    }
    case 'channels':
      await handleChannelsCommand(subargs);
      break;
    case 'browser':
      await handleBrowserCommand(subargs);
      break;
    case 'migrate':
      await handleMigrateCommand(subargs);
      break;
    case 'openclaw':
      await handleAgentMigrationCommand('openclaw', subargs);
      break;
    case 'hermes':
      await handleAgentMigrationCommand('hermes', subargs);
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
    case 'tool':
      await handleToolCommand(subargs);
      break;
    case 'update': {
      if (isHelpRequest(subargs)) {
        const { printUpdateUsage } = await import('./update.js');
        printUpdateUsage();
        break;
      }
      const { runUpdateCommand } = await import('./update.js');
      await runUpdateCommand(subargs, resolveCliVersion());
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
      if (await printHelpTopic(topic)) {
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

function isMissingRequiredEnvVarError(
  err: unknown,
): err is Error & { envVar: string } {
  return (
    err instanceof Error &&
    err.name === 'MissingRequiredEnvVarError' &&
    typeof (err as { envVar?: unknown }).envVar === 'string'
  );
}

function isCodexAuthError(
  err: unknown,
): err is Error & { reloginRequired: boolean } {
  return (
    err instanceof Error &&
    err.name === 'CodexAuthError' &&
    typeof (err as { reloginRequired?: unknown }).reloginRequired === 'boolean'
  );
}

function isWhatsAppAuthLockError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'WhatsAppAuthLockError';
}

function printMissingEnvVarError(message: string, envVar?: string): void {
  const envVarMessage: Record<string, string> = {
    HYBRIDAI_API_KEY: 'HybridAI provider is not configured.',
    OPENROUTER_API_KEY: 'OpenRouter provider is not configured.',
    MISTRAL_API_KEY: 'Mistral provider is not configured.',
    HF_TOKEN: 'Hugging Face provider is not configured.',
  };
  const envVarHint: Record<string, string> = {
    HYBRIDAI_API_KEY: `Run \`hybridclaw auth login hybridai\`, or set HYBRIDAI_API_KEY in ${runtimeSecretsPath()} or your shell, then run the command again.`,
    OPENROUTER_API_KEY: `Run \`hybridclaw auth login openrouter\`, or set OPENROUTER_API_KEY in ${runtimeSecretsPath()} or your shell, then run the command again.`,
    MISTRAL_API_KEY: `Run \`hybridclaw auth login mistral\`, or set MISTRAL_API_KEY in ${runtimeSecretsPath()} or your shell, then run the command again.`,
    HF_TOKEN: `Run \`hybridclaw auth login huggingface\`, or set HF_TOKEN in ${runtimeSecretsPath()} or your shell, then run the command again.`,
  };
  const renderedMessage = envVar ? envVarMessage[envVar] || message : message;
  const hint = envVar
    ? envVarHint[envVar]
    : 'Set this variable and rerun the command.';
  console.error(`hybridclaw error: ${renderedMessage}`);
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
    if (isMissingRequiredEnvVarError(err)) {
      printMissingEnvVarError(err.message, err.envVar);
    } else if (isCodexAuthError(err)) {
      console.error(`hybridclaw error: ${err.message}`);
      if (err.reloginRequired) {
        console.error(
          'Hint: Run `hybridclaw auth login codex` or `hybridclaw onboarding` to refresh OpenAI Codex credentials.',
        );
      }
    } else if (isWhatsAppAuthLockError(err)) {
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
