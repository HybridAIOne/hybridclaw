import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GatewayRuntime } from './gateway-runtime.js';

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const spawnMock = vi.mocked(spawn);

class MockChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.signalCode = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  });

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

describe('GatewayRuntime', () => {
  let runtimeRoot: string;

  beforeEach(() => {
    spawnMock.mockReset();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-gateway-runtime-'));
    fs.mkdirSync(path.join(runtimeRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'bin', 'node'), '');
    fs.writeFileSync(path.join(runtimeRoot, 'dist', 'cli.js'), '');
    fs.chmodSync(path.join(runtimeRoot, 'bin', 'node'), 0o755);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('not reachable');
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('reports startup child output and suppresses duplicate crash events', async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const logPath = path.join(runtimeRoot, 'logs', 'gateway.log');
    const runtime = new GatewayRuntime({
      baseUrl: 'http://127.0.0.1:9090',
      logPath,
      packaged: true,
      processEnv: {},
      processExecPath: '/Applications/HybridClaw.app/Contents/MacOS/HybridClaw',
      runtimeRoot,
    });
    const unexpectedExit = vi.fn();
    runtime.on('unexpected-exit', unexpectedExit);

    const started = runtime.ensureRunning(1_000);
    await waitFor(() => spawnMock.mock.calls.length > 0);

    child.stderr.write('\u001b[31mstartup exploded\u001b[39m\n');
    child.exit(1);

    await expect(started).rejects.toThrow(
      /gateway exited before becoming reachable/i,
    );
    await expect(started).rejects.toThrow(/startup exploded/);
    await expect(started).rejects.toThrow(logPath);
    expect(unexpectedExit).not.toHaveBeenCalled();
    await waitFor(() => fs.existsSync(logPath));
    expect(fs.readFileSync(logPath, 'utf8')).toContain('startup exploded');
  });

  test('emits unexpected-exit for crashes after startup succeeds', async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (spawnMock.mock.calls.length === 0) {
          throw new Error('not reachable');
        }
        return { ok: true };
      }),
    );
    const runtime = new GatewayRuntime({
      baseUrl: 'http://127.0.0.1:9090',
      packaged: true,
      processEnv: {},
      processExecPath: '/Applications/HybridClaw.app/Contents/MacOS/HybridClaw',
      runtimeRoot,
    });
    const unexpectedExit = vi.fn();
    runtime.on('unexpected-exit', unexpectedExit);

    await runtime.ensureRunning(1_000);
    child.exit(1);

    expect(unexpectedExit).toHaveBeenCalledWith({ code: 1, signal: null });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for predicate.');
}
