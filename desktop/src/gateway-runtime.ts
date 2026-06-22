import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildGatewayEnv,
  type DesktopRoute,
  normalizeGatewayBaseUrl,
  routeUrl,
} from './gateway-target.js';
import {
  resolveGatewayEntry,
  resolveGatewayNodeExecutable,
} from './runtime-paths.js';

const GATEWAY_READY_TIMEOUT_MS = 20_000;
const GATEWAY_PING_TIMEOUT_MS = 1_500;
const RECENT_OUTPUT_LIMIT = 12_000;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  'g',
);

export interface GatewayRuntimeOptions {
  baseUrl: string;
  logPath?: string | null;
  packaged: boolean;
  processEnv: NodeJS.ProcessEnv;
  processExecPath: string;
  runtimeRoot: string;
}

export interface GatewayExitPayload {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class GatewayRuntime extends EventEmitter {
  readonly baseUrl: string;
  readonly logPath: string | null;
  readonly packaged: boolean;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly processExecPath: string;
  readonly runtimeRoot: string;
  #child: ChildProcess | null = null;
  #lastExitPayload: GatewayExitPayload | null = null;
  #lastSpawnError: Error | null = null;
  #recentChildOutput = '';
  #startedChild = false;
  #startupInProgress = false;
  #stopping = false;

  constructor(options: GatewayRuntimeOptions) {
    super();
    this.baseUrl = normalizeGatewayBaseUrl(options.baseUrl);
    this.logPath = options.logPath ?? null;
    this.packaged = options.packaged;
    this.processEnv = options.processEnv;
    this.processExecPath = options.processExecPath;
    this.runtimeRoot = options.runtimeRoot;
  }

  get startedChild(): boolean {
    return this.#startedChild;
  }

  async ensureRunning(timeoutMs = GATEWAY_READY_TIMEOUT_MS): Promise<void> {
    if (await isGatewayReachable(this.baseUrl)) return;

    this.#startupInProgress = true;
    let ready = false;
    try {
      const child = this.#child ?? this.startChild();

      ready = await waitForGatewayReachable(this.baseUrl, timeoutMs, child);
    } finally {
      this.#startupInProgress = false;
    }
    if (ready) return;

    await this.stop();
    throw new Error(this.formatStartupFailure(timeoutMs));
  }

  async restart(timeoutMs = GATEWAY_READY_TIMEOUT_MS): Promise<void> {
    await this.stop();
    this.#startupInProgress = true;
    let ready = false;
    try {
      const child = this.startChild();
      ready = await waitForGatewayReachable(this.baseUrl, timeoutMs, child);
    } finally {
      this.#startupInProgress = false;
    }
    if (ready) return;

    await this.stop();
    throw new Error(this.formatStartupFailure(timeoutMs));
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;

    this.#stopping = true;
    child.kill('SIGTERM');
    await waitForExit(child, 5_000);
    this.#child = null;
    this.#startedChild = false;
    this.#stopping = false;
  }

  requestStop(): void {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    child.kill('SIGTERM');
  }

  routeUrl(route: DesktopRoute): string {
    return routeUrl(this.baseUrl, route);
  }

  private startChild(): ChildProcess {
    const gatewayEntry = resolveGatewayEntry(this.runtimeRoot);
    const nodeExecutable = resolveGatewayNodeExecutable({
      env: this.processEnv,
      packaged: this.packaged,
      processExecPath: this.processExecPath,
      runtimeRoot: this.runtimeRoot,
    });

    if (!fs.existsSync(gatewayEntry)) {
      throw new Error(
        `HybridClaw gateway build not found at ${gatewayEntry}. Run \`npm run build\` before starting the desktop app.`,
      );
    }
    if (!fs.existsSync(nodeExecutable)) {
      throw new Error(
        this.packaged
          ? `HybridClaw bundled Node runtime not found at ${nodeExecutable}. Rebuild the desktop app package.`
          : `HybridClaw Node runtime not found at ${nodeExecutable}. Relaunch the desktop app from \`npm run desktop\`.`,
      );
    }

    const runtimeNodeModules = path.join(this.runtimeRoot, 'node_modules');
    if (this.packaged && !fs.existsSync(runtimeNodeModules)) {
      throw new Error(
        `HybridClaw bundled gateway dependencies not found at ${runtimeNodeModules}. Rebuild the desktop app package.`,
      );
    }

    this.#lastExitPayload = null;
    this.#lastSpawnError = null;
    this.#recentChildOutput = '';

    const logStream = this.openLogStream();
    const child = spawn(
      nodeExecutable,
      [gatewayEntry, 'gateway', 'start', '--foreground'],
      {
        cwd: this.runtimeRoot,
        env: buildGatewayEnv(this.baseUrl),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.captureChildOutput('stdout', chunk, logStream);
      process.stdout.write(`[hybridclaw-desktop] ${chunk}`);
    });
    child.stderr?.on('data', (chunk: string) => {
      this.captureChildOutput('stderr', chunk, logStream);
      process.stderr.write(`[hybridclaw-desktop] ${chunk}`);
    });

    child.on('error', (error) => {
      this.#lastSpawnError = error;
      this.captureChildOutput(
        'error',
        `Failed to spawn gateway child: ${error.message}\n`,
        logStream,
      );
      if (this.#child === child) {
        this.#child = null;
        this.#startedChild = false;
      }
      if (!this.#stopping && !this.#startupInProgress) {
        this.emit('unexpected-exit', {
          code: null,
          signal: null,
        } satisfies GatewayExitPayload);
      }
    });

    child.on('exit', (code, signal) => {
      this.#lastExitPayload = { code, signal };
      if (this.#child === child) {
        this.#child = null;
        this.#startedChild = false;
      }
      this.writeLog(
        'exit',
        `Gateway child exited with code ${String(code)}, signal ${String(signal)}.\n`,
        logStream,
      );
      if (this.#stopping) {
        this.#stopping = false;
        return;
      }
      if (this.#startupInProgress) return;
      this.emit('unexpected-exit', {
        code,
        signal,
      } satisfies GatewayExitPayload);
    });
    child.once('close', () => {
      logStream?.end();
    });

    this.#child = child;
    this.#startedChild = true;
    this.writeLog(
      'start',
      `Starting gateway child: ${nodeExecutable} ${gatewayEntry} gateway start --foreground\n`,
      logStream,
    );
    return child;
  }

  private openLogStream(): fs.WriteStream | null {
    if (!this.logPath) return null;

    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      return fs.createWriteStream(this.logPath, { flags: 'a' });
    } catch (error) {
      this.#recentChildOutput = trimRecentOutput(
        `${this.#recentChildOutput}Failed to open desktop gateway log at ${this.logPath}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return null;
    }
  }

  private captureChildOutput(
    source: string,
    chunk: string,
    logStream: fs.WriteStream | null,
  ): void {
    const text = String(chunk);
    this.#recentChildOutput = trimRecentOutput(
      `${this.#recentChildOutput}${stripAnsi(text)}`,
    );
    this.writeLog(source, text, logStream);
  }

  private writeLog(
    source: string,
    text: string,
    logStream: fs.WriteStream | null,
  ): void {
    if (!logStream) return;
    logStream.write(prefixLogLines(source, text));
  }

  private formatStartupFailure(timeoutMs: number): string {
    const recentOutput = this.#recentChildOutput.trim();
    const logHint = this.logPath ? `\n\nGateway log: ${this.logPath}` : '';
    const outputHint = recentOutput
      ? `\n\nRecent gateway output:\n${recentOutput}`
      : '';

    if (this.#lastSpawnError) {
      return `HybridClaw gateway failed to launch: ${this.#lastSpawnError.message}.${logHint}${outputHint}`;
    }
    if (this.#lastExitPayload) {
      return (
        `HybridClaw gateway exited before becoming reachable at ${this.baseUrl} ` +
        `(code ${String(this.#lastExitPayload.code)}, signal ${String(this.#lastExitPayload.signal)}).` +
        `${logHint}${outputHint}`
      );
    }

    return (
      `HybridClaw gateway did not become reachable at ${this.baseUrl} within ${timeoutMs}ms.` +
      `${logHint}${outputHint}`
    );
  }
}

async function isGatewayReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', `${baseUrl}/`), {
      signal: AbortSignal.timeout(GATEWAY_PING_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForGatewayReachable(
  baseUrl: string,
  timeoutMs: number,
  child?: ChildProcess | null,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  let exited = false;
  const onExit = () => {
    exited = true;
  };
  child?.once('exit', onExit);
  child?.once('error', onExit);

  try {
    while (Date.now() < deadline && !exited) {
      if (await isGatewayReachable(baseUrl)) return true;
      await delay(250);
    }
    return isGatewayReachable(baseUrl);
  } finally {
    child?.removeListener('exit', onExit);
    child?.removeListener('error', onExit);
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    const done = () => {
      child.removeListener('exit', done);
      child.removeListener('close', done);
      child.removeListener('error', done);
      resolve();
    };
    child.once('exit', done);
    child.once('close', done);
    child.once('error', done);
  });

  const killTimer = delay(timeoutMs).then(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });

  await Promise.race([exited, killTimer]);
  // Always wait for the actual `exit` event before returning so callers can
  // safely clear their #stopping flag without racing the exit handler.
  await exited;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function trimRecentOutput(text: string): string {
  if (text.length <= RECENT_OUTPUT_LIMIT) return text;
  return text.slice(text.length - RECENT_OUTPUT_LIMIT);
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

function prefixLogLines(source: string, text: string): string {
  const timestamp = new Date().toISOString();
  return text
    .split(/(?<=\n)/)
    .map((line) => `[${timestamp}] ${source}: ${line}`)
    .join('');
}
