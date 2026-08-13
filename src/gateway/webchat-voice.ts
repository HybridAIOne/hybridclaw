/**
 * Browser realtime voice sessions for the web console chat surface.
 *
 * Owns the `/api/chat/voice/stream` websocket protocol: JSON frames carrying
 * base64 PCM16 (24 kHz mono) mic audio from the browser into a per-connection
 * `RealtimeCallBridge`, and model audio, barge-in clears, state, and
 * transcripts back. `consult_agent` runs an ordinary web chat turn through
 * `handleGatewayMessage`, so tools, approvals, and session history behave
 * exactly like typed chat.
 *
 * Threat model: the HTTP server authenticates the upgrade (session cookie or
 * loopback web session) BEFORE handing sockets to this module — nothing here
 * may run for anonymous peers. This module still enforces its own limits:
 * bounded frame size, a concurrent-session cap, a start deadline for idle
 * sockets, and canonical-session-id validation so a client cannot consult
 * into an arbitrary key shape. Audio payloads are opaque and never logged;
 * transcripts are logged as lengths only.
 *
 * NOT the Twilio path: phone calls live in `src/channels/voice/runtime.ts`.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, * as wsModule from 'ws';
import type { RealtimeSocketFactory } from '../channels/voice/openai-realtime.js';
import {
  type RealtimeBridgeState,
  RealtimeCallBridge,
} from '../channels/voice/realtime-bridge.js';
import { formatTextForVoice } from '../channels/voice/text.js';
import { getConfigSnapshot, OPENAI_API_KEY } from '../config/config.js';
import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  buildSessionKey,
  classifySessionKeyShape,
} from '../session/session-key.js';
import { handleGatewayMessage } from './gateway-chat-service.js';

export const WEBCHAT_VOICE_STREAM_PATH = '/api/chat/voice/stream';

const MAX_CONCURRENT_SESSIONS = 4;
const MAX_FRAME_BYTES = 256 * 1024;
const START_DEADLINE_MS = 10_000;

export interface WebchatVoiceIdentity {
  userId: string | null;
  username: string | null;
}

export function isWebchatVoiceAvailable(): boolean {
  return Boolean(String(OPENAI_API_KEY || '').trim());
}

interface ClientFrame {
  type: string;
  payload?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
}

function sendFrame(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame), () => {
    // Send failures surface through the socket error/close handlers.
  });
}

function resolveVoiceSessionId(requested: unknown, agentId: string): string {
  const candidate = typeof requested === 'string' ? requested.trim() : '';
  if (
    candidate &&
    classifySessionKeyShape(candidate) !== 'canonical_malformed'
  ) {
    return candidate;
  }
  return buildSessionKey(
    agentId,
    'web',
    'dm',
    randomUUID().replace(/-/g, '').slice(0, 16),
  );
}

export interface WebchatVoiceConnectionOptions {
  ws: WebSocket;
  identity: WebchatVoiceIdentity;
  remoteIp: string;
  onFinished: () => void;
  /** Test seam: injected upstream realtime socket factory. */
  socketFactory?: RealtimeSocketFactory;
}

export class WebchatVoiceConnection {
  private bridge: RealtimeCallBridge | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly ws: WebSocket;
  private readonly identity: WebchatVoiceIdentity;
  private readonly remoteIp: string;
  private readonly onFinished: () => void;
  private readonly socketFactory?: RealtimeSocketFactory;

  constructor(options: WebchatVoiceConnectionOptions) {
    this.ws = options.ws;
    this.identity = options.identity;
    this.remoteIp = options.remoteIp;
    this.onFinished = options.onFinished;
    this.socketFactory = options.socketFactory;
    const ws = this.ws;
    this.startTimer = setTimeout(() => {
      this.fail('Voice session was not started in time.', 1008);
    }, START_DEADLINE_MS);
    ws.on('message', (raw) => {
      this.handleFrame(raw);
    });
    ws.on('close', () => {
      this.teardown();
    });
    ws.on('error', (error) => {
      logger.debug(
        { error, remoteIp: this.remoteIp },
        'Webchat voice websocket error',
      );
    });
  }

  private handleFrame(raw: WebSocket.Data): void {
    let frame: ClientFrame;
    try {
      const parsed = JSON.parse(String(raw)) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Frame was not a JSON object.');
      }
      frame = parsed as ClientFrame;
    } catch {
      this.fail('Invalid voice frame.', 1008);
      return;
    }
    if (frame.type === 'start') {
      this.handleStart(frame);
      return;
    }
    if (frame.type === 'audio') {
      if (typeof frame.payload === 'string' && this.bridge) {
        this.bridge.handleCallerAudio(frame.payload);
      }
      return;
    }
    if (frame.type === 'stop') {
      sendFrame(this.ws, { type: 'ended' });
      this.ws.close(1000, 'Voice session ended');
      return;
    }
    this.fail(`Unknown voice frame type: ${String(frame.type)}`, 1008);
  }

  private handleStart(frame: ClientFrame): void {
    if (this.bridge) {
      this.fail('Voice session already started.', 1008);
      return;
    }
    const apiKey = String(OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      this.fail(
        'Realtime voice requires an OpenAI API key (OPENAI_API_KEY).',
        1011,
      );
      return;
    }
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    const agentId =
      (typeof frame.agentId === 'string' && frame.agentId.trim()) ||
      resolveDefaultAgentId(getRuntimeConfig());
    const sessionId = resolveVoiceSessionId(frame.sessionId, agentId);
    const userId = this.identity.userId || sessionId;
    const username = this.identity.username || 'web';
    const voiceConfig = getConfigSnapshot().voice.realtime;
    this.bridge = new RealtimeCallBridge({
      apiKey,
      config: voiceConfig,
      caller: { from: '', to: '', callerName: username },
      surface: 'web',
      audioFormat: { type: 'audio/pcm', rate: 24000 },
      sendAudio: async (base64Audio) => {
        sendFrame(this.ws, { type: 'audio', payload: base64Audio });
      },
      clearPlayback: async () => {
        sendFrame(this.ws, { type: 'clear' });
      },
      consultAgent: async (request, abortSignal) => {
        const result = await handleGatewayMessage({
          sessionId,
          guildId: null,
          channelId: 'web',
          userId,
          username,
          content: request,
          agentId,
          abortSignal,
          source: 'webchat.voice',
        });
        if (result.status !== 'success') {
          throw new Error(result.error || 'Chat turn failed.');
        }
        return formatTextForVoice(result.result || '');
      },
      onTranscript: (role, text) => {
        logger.debug(
          { sessionId, role, transcriptLength: text.length },
          'Webchat voice transcript',
        );
        sendFrame(this.ws, {
          type: 'transcript',
          role: role === 'caller' ? 'user' : 'assistant',
          text,
        });
      },
      onStateChange: (state: RealtimeBridgeState) => {
        sendFrame(this.ws, { type: 'state', state });
      },
      onError: (message) => {
        logger.warn(
          { sessionId, remoteIp: this.remoteIp, message },
          'Webchat voice bridge error',
        );
        sendFrame(this.ws, { type: 'error', message });
      },
      onClosed: () => {
        // Upstream loss is unrecoverable; end the browser session too.
        sendFrame(this.ws, { type: 'ended' });
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1011, 'Realtime session closed');
        }
      },
      socketFactory: this.socketFactory,
    });
    sendFrame(this.ws, { type: 'ready', sessionId });
    logger.info(
      { sessionId, remoteIp: this.remoteIp },
      'Webchat voice session started',
    );
  }

  private fail(message: string, code: number): void {
    sendFrame(this.ws, { type: 'error', message });
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(code, message.slice(0, 120));
    }
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.bridge?.close();
    this.bridge = null;
    this.onFinished();
  }
}

const WebSocketServerCtor = (
  wsModule as unknown as {
    WebSocketServer: new (options: {
      noServer: true;
      maxPayload: number;
    }) => {
      handleUpgrade: (
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        cb: (ws: WebSocket) => void,
      ) => void;
    };
  }
).WebSocketServer;

class WebchatVoiceManager {
  private readonly wss = new WebSocketServerCtor({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  private activeSessions = 0;

  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    identity: WebchatVoiceIdentity,
  ): void {
    const remoteIp = String(req.socket.remoteAddress || 'unknown');
    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      if (this.activeSessions >= MAX_CONCURRENT_SESSIONS) {
        ws.close(1013, 'Too many voice sessions');
        return;
      }
      this.activeSessions += 1;
      new WebchatVoiceConnection({
        ws,
        identity,
        remoteIp,
        onFinished: () => {
          this.activeSessions = Math.max(0, this.activeSessions - 1);
        },
      });
    });
  }
}

export const webchatVoiceManager = new WebchatVoiceManager();
