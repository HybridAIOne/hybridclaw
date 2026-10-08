import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.js';

type ExitHandler = (event: {
  exitCode: number | null | undefined;
  signal: number | null | undefined;
}) => void;

class FakePty {
  private dataHandler: ((data: string) => void) | null = null;
  private exitHandler: ExitHandler | null = null;

  kill = vi.fn();
  resize = vi.fn();
  write = vi.fn();

  onData(handler: (data: string) => void): void {
    this.dataHandler = handler;
  }

  onExit(handler: ExitHandler): void {
    this.exitHandler = handler;
  }

  emitData(data: string): void {
    this.dataHandler?.(data);
  }

  emitExit(exitCode: number | null, signal: number | null): void {
    this.exitHandler?.({ exitCode, signal });
  }
}

class FakeWebSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  sent: string[] = [];
  close = vi.fn(() => {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  });

  private listeners = new Map<string, Array<(value?: unknown) => void>>();

  on(event: string, handler: (value?: unknown) => void): void {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emit(event: string, value?: unknown): void {
    for (const handler of this.listeners.get(event) || []) {
      handler(value);
    }
  }
}

describe('admin terminal manager', () => {
  const makeTempDir = useTempDir('hc-admin-terminal-');
  let spawnedPtys: FakePty[] = [];
  let nextWebSocket: FakeWebSocket | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnedPtys = [];
    nextWebSocket = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test('keeps exited sessions attachable until timeout and closes after replaying exit', async () => {
    vi.doMock('node-pty', () => ({
      spawn: vi.fn(() => {
        const pty = new FakePty();
        spawnedPtys.push(pty);
        return pty;
      }),
    }));

    vi.doMock('ws', () => ({
      WebSocketServer: class {
        handleUpgrade(
          _req: IncomingMessage,
          _socket: Duplex,
          _head: Buffer,
          cb: (socket: FakeWebSocket) => void,
        ): void {
          cb(nextWebSocket ?? new FakeWebSocket());
        }

        close(): void {}
      },
    }));

    const { createAdminTerminalManager } = await import(
      '../src/gateway/admin-terminal.ts'
    );
    const manager = createAdminTerminalManager();
    const started = await manager.startSession();
    const pty = spawnedPtys[0];
    expect(pty).toBeDefined();

    pty.emitData('boot\n');
    pty.emitExit(7, null);
    vi.advanceTimersByTime(2_000);

    const ws = new FakeWebSocket();
    nextWebSocket = ws;

    const upgraded = manager.handleUpgrade(
      {} as IncomingMessage,
      {} as Duplex,
      Buffer.alloc(0),
      new URL(`http://localhost${started.websocketPath}`),
      { hasRequestAuth: true },
    );

    expect(upgraded).toBe(true);
    expect(ws.sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: 'output',
        data: 'boot\n',
      },
      {
        type: 'exit',
        exitCode: 7,
        signal: null,
      },
    ]);
    expect(ws.close).toHaveBeenCalledTimes(1);

    manager.dispose();
  });

  test('a node-pty load failure fails only the session start, not the module import', async () => {
    vi.doMock('node-pty', () => {
      throw new Error('node-pty prebuild missing');
    });

    const { createAdminTerminalManager } = await import(
      '../src/gateway/admin-terminal.ts'
    );
    const manager = createAdminTerminalManager();

    await expect(manager.startSession()).rejects.toMatchObject({
      statusCode: 503,
    });

    manager.dispose();
  });

  test('restores the spawn-helper execute bit on the first session start, not on import', async () => {
    const installRoot = makeTempDir();
    const helperDir = path.join(
      installRoot,
      'node_modules',
      'node-pty',
      'prebuilds',
      'darwin-arm64',
    );
    const helperPath = path.join(helperDir, 'spawn-helper');
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(helperPath, '');
    fs.chmodSync(helperPath, 0o644);
    fs.mkdirSync(path.join(installRoot, 'dist'));
    fs.writeFileSync(path.join(installRoot, 'dist', 'cli.js'), '');
    vi.doMock('../src/infra/install-root.js', () => ({
      resolveInstallRoot: () => installRoot,
    }));
    vi.doMock('node-pty', () => ({ spawn: vi.fn(() => new FakePty()) }));

    const { createAdminTerminalManager } = await import(
      '../src/gateway/admin-terminal.ts'
    );
    const manager = createAdminTerminalManager();
    expect(fs.statSync(helperPath).mode & 0o111).toBe(0);

    await manager.startSession();
    expect(fs.statSync(helperPath).mode & 0o777).toBe(0o755);

    manager.dispose();
  });
});
