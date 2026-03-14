import WebSocket from 'ws';

import type {
  CdpEventMessage,
  CdpSendOptions,
  CdpWaitForEventOptions,
} from './types.js';

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
};

type EventHandler = (event: CdpEventMessage) => void;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class CdpTransport {
  private readonly commandTimeoutMs: number;

  private readonly eventHandlers = new Map<string, Set<EventHandler>>();

  private readonly globalHandlers = new Set<EventHandler>();

  private readonly pending = new Map<number, PendingRequest>();

  private nextId = 1;

  private socket: WebSocket | null = null;

  private openPromise: Promise<void> | null = null;

  constructor(readonly wsUrl: string, options: { timeoutMs?: number } = {}) {
    this.commandTimeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 120_000),
    );
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.openPromise = null;
        reject(error);
      };

      socket.once('open', () => {
        settled = true;
        this.socket = socket;
        this.openPromise = null;
        resolve();
      });
      socket.on('message', (data) => this.handleMessage(data));
      socket.once('error', (error) => {
        if (!settled) {
          fail(
            error instanceof Error
              ? error
              : new Error(String(error || 'CDP socket error')),
          );
          return;
        }
        this.rejectPending(
          error instanceof Error
            ? error
            : new Error(String(error || 'CDP socket error')),
        );
      });
      socket.once('close', () => {
        this.socket = null;
        this.openPromise = null;
        this.rejectPending(new Error('CDP socket closed'));
      });
    });

    return this.openPromise;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.openPromise = null;
    if (!socket) return;

    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      try {
        socket.close();
      } catch {
        resolve();
      }
    });
    this.rejectPending(new Error('CDP socket closed'));
  }

  on(method: string, handler: EventHandler): () => void {
    const bucket = this.eventHandlers.get(method) ?? new Set<EventHandler>();
    bucket.add(handler);
    this.eventHandlers.set(method, bucket);
    return () => {
      const current = this.eventHandlers.get(method);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.eventHandlers.delete(method);
    };
  }

  onEvent(handler: EventHandler): () => void {
    this.globalHandlers.add(handler);
    return () => {
      this.globalHandlers.delete(handler);
    };
  }

  async waitForEvent(
    method: string,
    predicate?: (event: CdpEventMessage) => boolean,
    options: CdpWaitForEventOptions = {},
  ): Promise<CdpEventMessage> {
    const timeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? this.commandTimeoutMs, 120_000),
    );
    return new Promise<CdpEventMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const cleanup = this.on(method, (event) => {
        if (options.sessionId && event.sessionId !== options.sessionId) return;
        if (predicate && !predicate(event)) return;
        clearTimeout(timer);
        cleanup();
        resolve(event);
      });
    });
  }

  async send<TResult = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: CdpSendOptions = {},
  ): Promise<TResult> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('CDP socket is not connected');
    }

    const id = this.nextId++;
    const timeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? this.commandTimeoutMs, 120_000),
    );
    const payload: Record<string, unknown> = { id, method };
    if (params && Object.keys(params).length > 0) payload.params = params;
    if (options.sessionId) payload.sessionId = options.sessionId;

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response to ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });

      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error(String(error || 'Failed to send CDP payload')),
        );
      }
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }

    const id =
      typeof parsed.id === 'number' && Number.isFinite(parsed.id)
        ? parsed.id
        : null;
    if (id != null) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (parsed.error) {
        const error = parsed.error as { message?: unknown };
        pending.reject(
          new Error(
            typeof error?.message === 'string'
              ? error.message
              : `CDP command failed: ${JSON.stringify(parsed.error)}`,
          ),
        );
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (typeof parsed.method !== 'string') return;
    const event: CdpEventMessage = {
      method: parsed.method,
      params: parsed.params,
      sessionId:
        typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
    };
    const scoped = this.eventHandlers.get(event.method);
    if (scoped) {
      for (const handler of scoped) handler(event);
    }
    for (const handler of this.globalHandlers) handler(event);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
