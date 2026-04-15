import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  buildGatewayEnv,
  normalizeGatewayBaseUrl,
  type DesktopRoute,
  routeUrl,
} from './gateway-target.js';
import {
  resolveGatewayEntry,
  resolveGatewayNodeExecutable,
} from './runtime-paths.js';

const GATEWAY_READY_TIMEOUT_MS = 20_000;
const GATEWAY_PING_TIMEOUT_MS = 1_500;

export interface GatewayRuntimeOptions {
  baseUrl: string;
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
  readonly packaged: boolean;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly processExecPath: string;
  readonly runtimeRoot: string;
  #child: ChildProcess | null = null;
  #startedChild = false;
  #stopping = false;

  constructor(options: GatewayRuntimeOptions) {
    super();
    this.baseUrl = normalizeGatewayBaseUrl(options.baseUrl);
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

    if (!this.#child) {
      this.startChild();
    }

    const ready = await waitForGatewayReachable(this.baseUrl, timeoutMs, this.#child);
    if (ready) return;

    await this.stop();
    throw new Error(
      `HybridClaw gateway did not become reachable at ${this.baseUrl} within ${timeoutMs}ms.`,
    );
  }

  async restart(timeoutMs = GATEWAY_READY_TIMEOUT_MS): Promise<void> {
    await this.stop();
    this.startChild();
    const ready = await waitForGatewayReachable(this.baseUrl, timeoutMs, this.#child);
    if (ready) return;

    await this.stop();
    throw new Error(
      `HybridClaw gateway did not become reachable at ${this.baseUrl} within ${timeoutMs}ms.`,
    );
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

  private startChild(): void {
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
      process.stdout.write(`[hybridclaw-desktop] ${chunk}`);
    });
    child.stderr?.on('data', (chunk: string) => {
      process.stderr.write(`[hybridclaw-desktop] ${chunk}`);
    });

    child.on('exit', (code, signal) => {
      if (this.#child === child) {
        this.#child = null;
        this.#startedChild = false;
      }
      if (this.#stopping) {
        this.#stopping = false;
        return;
      }
      this.emit('unexpected-exit', {
        code,
        signal,
      } satisfies GatewayExitPayload);
    });

    this.#child = child;
    this.#startedChild = true;
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
  const onExit = () => { exited = true; };
  child?.once('exit', onExit);

  try {
    while (Date.now() < deadline && !exited) {
      if (await isGatewayReachable(baseUrl)) return true;
      await delay(250);
    }
    return isGatewayReachable(baseUrl);
  } finally {
    child?.removeListener('exit', onExit);
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    }),
    delay(timeoutMs).then(() => {
      child.kill('SIGKILL');
    }),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
