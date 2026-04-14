import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  buildGatewayEnv,
  normalizeGatewayBaseUrl,
  type DesktopRoute,
  routeUrl,
} from './gateway-target.js';
import { resolveGatewayEntry } from './runtime-paths.js';

const GATEWAY_READY_TIMEOUT_MS = 20_000;
const GATEWAY_PING_TIMEOUT_MS = 1_500;

export interface GatewayRuntimeOptions {
  baseUrl: string;
  runtimeRoot: string;
}

export interface GatewayExitPayload {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class GatewayRuntime extends EventEmitter {
  readonly baseUrl: string;
  readonly runtimeRoot: string;
  #child: ChildProcess | null = null;
  #startedChild = false;
  #stopping = false;

  constructor(options: GatewayRuntimeOptions) {
    super();
    this.baseUrl = normalizeGatewayBaseUrl(options.baseUrl);
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

    const ready = await waitForGatewayReachable(this.baseUrl, timeoutMs);
    if (ready) return;

    await this.stop();
    throw new Error(
      `HybridClaw gateway did not become reachable at ${this.baseUrl} within ${timeoutMs}ms.`,
    );
  }

  async restart(timeoutMs = GATEWAY_READY_TIMEOUT_MS): Promise<void> {
    await this.stop();
    await this.ensureRunning(timeoutMs);
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
    if (!fs.existsSync(gatewayEntry)) {
      throw new Error(
        `HybridClaw gateway build not found at ${gatewayEntry}. Run \`npm run build\` before starting the desktop app.`,
      );
    }

    const child = spawn(
      process.execPath,
      [gatewayEntry, 'gateway', 'start', '--foreground'],
      {
        cwd: this.runtimeRoot,
        env: {
          ...buildGatewayEnv(this.baseUrl),
          ELECTRON_RUN_AS_NODE: '1',
        },
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
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGatewayReachable(baseUrl)) return true;
    await delay(250);
  }
  return isGatewayReachable(baseUrl);
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
