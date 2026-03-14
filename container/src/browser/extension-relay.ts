import { randomBytes } from 'node:crypto';
import http from 'node:http';

import WebSocket, { WebSocketServer } from 'ws';

import type {
  CdpEventMessage,
  CdpSendOptions,
  CdpWaitForEventOptions,
} from './types.js';

type RelayPendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
};

type RelayEventHandler = (event: CdpEventMessage) => void;

type RelayMessage =
  | {
      type: 'ForwardCommand';
      id: number;
      method: string;
      params?: unknown;
      sessionId?: string;
    }
  | {
      type: 'Response';
      id: number;
      result?: unknown;
      error?: string;
    }
  | {
      type: 'ForwardEvent';
      method: string;
      params?: unknown;
      sessionId?: string;
    }
  | {
      type: 'Ping' | 'Pong';
    };

const DEFAULT_TIMEOUT_MS = 30_000;

export class ChromeExtensionRelayServer {
  private readonly token = randomBytes(18).toString('base64url');

  private readonly pending = new Map<number, RelayPendingRequest>();

  private readonly eventHandlers = new Set<RelayEventHandler>();

  private readonly server = http.createServer();

  private readonly wss = new WebSocketServer({ noServer: true });

  private client: WebSocket | null = null;

  private nextId = 1;

  private listeningPort = 0;

  constructor() {
    this.server.on('upgrade', (request, socket, head) => {
      const headerToken = String(
        request.headers['x-openclaw-relay-token'] || '',
      ).trim();
      if (headerToken !== this.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (socket) => {
      this.client = socket;
      socket.on('message', (raw) => this.handleMessage(raw));
      socket.on('close', () => {
        if (this.client === socket) this.client = null;
      });
      socket.on('error', () => {
        if (this.client === socket) this.client = null;
      });
    });
  }

  get port(): number {
    return this.listeningPort;
  }

  get relayToken(): string {
    return this.token;
  }

  async start(): Promise<void> {
    if (this.listeningPort > 0) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        this.listeningPort =
          typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  }

  async waitForClient(timeoutMs = 5_000): Promise<void> {
    if (this.client) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for the Chrome extension relay'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.wss.off('connection', onConnection);
      };
      const onConnection = () => {
        cleanup();
        resolve();
      };
      this.wss.on('connection', onConnection);
    });
  }

  onEvent(handler: RelayEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  async waitForEvent(
    method: string,
    predicate?: (event: CdpEventMessage) => boolean,
    options: CdpWaitForEventOptions = {},
  ): Promise<CdpEventMessage> {
    const timeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000),
    );
    return new Promise<CdpEventMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for relay event ${method}`));
      }, timeoutMs);
      const cleanup = this.onEvent((event) => {
        if (event.method !== method) return;
        if (options.sessionId && event.sessionId !== options.sessionId) return;
        if (predicate && !predicate(event)) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
      const off = cleanup;
    });
  }

  async send<TResult = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: CdpSendOptions = {},
  ): Promise<TResult> {
    await this.start();
    const client = this.client;
    if (!client || client.readyState !== WebSocket.OPEN) {
      throw new Error('Chrome extension relay is not connected');
    }
    const id = this.nextId++;
    const timeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000),
    );

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for relay response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });
      client.send(
        JSON.stringify({
          type: 'ForwardCommand',
          id,
          method,
          ...(params ? { params } : {}),
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        } satisfies RelayMessage),
      );
    });
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Extension relay closed'));
      this.pending.delete(id);
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.client?.close();
    this.client = null;
    this.listeningPort = 0;
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let parsed: RelayMessage;
    try {
      parsed = JSON.parse(String(raw)) as RelayMessage;
    } catch {
      return;
    }

    if (parsed.type === 'Response') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error));
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (parsed.type === 'ForwardEvent') {
      const event: CdpEventMessage = {
        method: parsed.method,
        params: parsed.params,
        sessionId: parsed.sessionId,
      };
      for (const handler of this.eventHandlers) handler(event);
      return;
    }

    if (parsed.type === 'Ping') {
      this.client?.send(JSON.stringify({ type: 'Pong' } satisfies RelayMessage));
    }
  }
}

export async function ensureChromeExtensionRelayServer(): Promise<ChromeExtensionRelayServer> {
  const server = new ChromeExtensionRelayServer();
  await server.start();
  return server;
}
