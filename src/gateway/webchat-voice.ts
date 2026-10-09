/**
 * Browser realtime voice sessions for the web console chat surface.
 *
 * Owns the `/api/chat/voice/stream` websocket protocol: JSON frames carrying
 * base64 PCM16 (24 kHz mono) mic audio from the browser into a per-connection
 * `RealtimeCallBridge`, and model audio, barge-in clears, state, consult
 * activity labels, and transcripts back. Spoken turns persist into session history as regular
 * user/assistant messages tagged `source: 'voice'`. `consult_agent` runs an
 * ordinary web chat turn through `handleGatewayMessage`, so tools, approvals,
 * and session history behave exactly like typed chat.
 * The prior conversation is preloaded before `ready` or the greeting; each
 * consultation receives a fresh clock and the validated client timezone.
 *
 * Threat model: the HTTP server authenticates the upgrade BEFORE handing
 * sockets to this module — nothing here may run for anonymous peers. Two
 * upgrade credentials exist: a session cookie / loopback web session (the
 * console), or a single-use short-lived stream token minted here over the
 * authenticated `/api/chat/voice/token` route (external API clients; browsers
 * cannot set websocket headers). This module still enforces its own limits:
 * bounded frame size, a concurrent-session cap, a start deadline for idle
 * sockets, and canonical-session-id validation so a client cannot consult
 * into an arbitrary key shape. Audio payloads are opaque and never logged;
 * transcripts are logged as lengths only.
 *
 * A session started with an existing chat's id hands the realtime model a
 * summary of that chat (`webchat-voice-context.ts`). Ownership is checked before
 * the compression auxiliary reads the text. The summary is sent to the realtime
 * provider as ordinary conversation data, never system instructions.
 *
 * NOT the phone path: calls arrive through transport plugins
 * (`plugins/twilio-voice`, `plugins/vonage-voice`).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, * as wsModule from 'ws';
import { displayNameForAgent } from '../agents/agent-registry.js';
import { getConfigSnapshot } from '../config/config.js';
import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  bindRequestedScope,
  deletedScopeError,
} from '../scopes/scope-session.js';
import {
  buildSessionKey,
  classifySessionKeyShape,
} from '../session/session-key.js';
import type { RealtimeSocketFactory } from '../voice/openai-realtime.js';
import {
  type RealtimeBridgeState,
  RealtimeCallBridge,
  type RealtimeCallContext,
  voiceLanguageCode,
} from '../voice/realtime-bridge.js';
import {
  isRealtimeCredentialConfigured,
  resolveRealtimeConnection,
} from '../voice/realtime-credentials.js';
import { formatTextForVoice } from '../voice/text.js';
import {
  formatCurrentTime,
  readUserNames,
  readUserTimezone,
} from '../workspace.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import { persistVoiceTranscript } from './voice-transcript-store.js';
import {
  loadWebchatVoiceHistory,
  voiceConsultInstructions,
} from './webchat-voice-context.js';

export const WEBCHAT_VOICE_STREAM_PATH = '/api/chat/voice/stream';
export const WEBCHAT_VOICE_TOKEN_PATH = '/api/chat/voice/token';

const MAX_CONCURRENT_SESSIONS = 4;
const MAX_FRAME_BYTES = 256 * 1024;
const START_DEADLINE_MS = 10_000;
// 2026-10-08: summary plus upstream preload must finish before the mobile
// client's 25s ringing limit. The auxiliary call gets at most 10s of this.
const PRELOAD_DEADLINE_MS = 20_000;
// 60s single-use TTL, small pending cap (call, 2026-08-24): clients mint and
// connect immediately, so the cap only bounds unclaimed mints.
const STREAM_TOKEN_TTL_MS = 60_000;
const MAX_PENDING_STREAM_TOKENS = 32;

export interface WebchatVoiceIdentity {
  userId: string | null;
  username: string | null;
  /**
   * The caller as chat ownership records it (`resolveWebNotificationOperator`):
   * a hashed operator id, not `userId`. Only this may read an owned chat.
   */
  operatorId?: string | null;
}

interface PendingVoiceStreamToken {
  identity: WebchatVoiceIdentity;
  expiresAtMs: number;
}

const pendingStreamTokens = new Map<string, PendingVoiceStreamToken>();

function prunePendingStreamTokens(): void {
  const now = Date.now();
  for (const [token, entry] of pendingStreamTokens) {
    if (entry.expiresAtMs <= now) pendingStreamTokens.delete(token);
  }
}

export function mintWebchatVoiceStreamToken(
  identity: WebchatVoiceIdentity,
): { token: string; expiresInSeconds: number } | null {
  prunePendingStreamTokens();
  if (pendingStreamTokens.size >= MAX_PENDING_STREAM_TOKENS) return null;
  const token = randomBytes(24).toString('base64url');
  pendingStreamTokens.set(token, {
    identity,
    expiresAtMs: Date.now() + STREAM_TOKEN_TTL_MS,
  });
  return { token, expiresInSeconds: STREAM_TOKEN_TTL_MS / 1000 };
}

export function consumeWebchatVoiceStreamToken(
  token: string,
): WebchatVoiceIdentity | null {
  prunePendingStreamTokens();
  const entry = pendingStreamTokens.get(token);
  if (!entry) return null;
  pendingStreamTokens.delete(token);
  return entry.identity;
}

export function isWebchatVoiceAvailable(): boolean {
  return isRealtimeCredentialConfigured(
    getConfigSnapshot().speech.realtime.provider,
  );
}

interface ClientFrame {
  type: string;
  payload?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
  client?: unknown;
  language?: unknown;
  timeZone?: unknown;
  scope?: unknown;
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

/**
 * What the voice knows before it picks up: its own name, the user's name and
 * local time. The chat summary is loaded separately as conversation data while
 * the phone app still rings. Each part is best effort, since a call without it
 * still works.
 */
function loadVoiceCallContext(
  agentId: string,
  timeZone?: string,
): { context: RealtimeCallContext; userName: string | null } {
  const context: RealtimeCallContext = {};
  let userName: string | null = null;
  try {
    context.assistantName = displayNameForAgent(agentId);
    const names = readUserNames(agentId);
    userName = names.name || names.fullName;
    context.now = formatCurrentTime(
      timeZone ?? readUserTimezone(agentId) ?? undefined,
    );
  } catch (err) {
    logger.warn({ err, agentId }, 'Webchat voice call context unavailable');
  }
  return { context, userName };
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
  private starting = false;
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
      void this.handleStart(frame).catch(() => {
        this.fail('Voice call could not be prepared.', 1011);
      });
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

  private async handleStart(frame: ClientFrame): Promise<void> {
    if (this.bridge || this.starting) {
      this.fail('Voice session already started.', 1008);
      return;
    }
    let timeZone: string | undefined;
    if (frame.timeZone !== undefined) {
      try {
        if (typeof frame.timeZone !== 'string' || frame.timeZone.length > 100) {
          throw new Error('Invalid timezone.');
        }
        timeZone = new Intl.DateTimeFormat('en', {
          timeZone: frame.timeZone,
        }).resolvedOptions().timeZone;
      } catch {
        this.fail('Invalid voice timezone.', 1008);
        return;
      }
    }
    const voiceConfig = getConfigSnapshot().speech.realtime;
    const resolved = resolveRealtimeConnection(voiceConfig.provider);
    if (!resolved.connection) {
      this.fail(resolved.error, 1011);
      return;
    }
    const agentId =
      (typeof frame.agentId === 'string' && frame.agentId.trim()) ||
      resolveDefaultAgentId(getRuntimeConfig());
    const sessionId = resolveVoiceSessionId(frame.sessionId, agentId);
    // A call from the phone app continues one of its chats, which must not
    // reset under it any more than when the app writes there.
    const client = frame.client === 'mobile' ? frame.client : undefined;
    // The language the user set for the AI (an app's setting); anything we
    // cannot pin is ignored and the voice keeps guessing as before.
    const language = voiceLanguageCode(frame.language) ?? undefined;
    const userId = this.identity.userId || sessionId;
    const username = this.identity.username || 'web';
    // A call can begin a side chat: it takes the frame's scope as a first
    // message would, and a chat whose scope is gone takes no call.
    const scopeError =
      bindRequestedScope({
        sessionId,
        guildId: null,
        channelId: 'web',
        agentId,
        requestedScope: frame.scope,
      }) ?? deletedScopeError(sessionId, agentId);
    if (scopeError) {
      this.fail(scopeError.error, 1008, scopeError.errorCode);
      return;
    }
    this.starting = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      this.fail('Voice conversation could not be prepared in time.', 1011);
    }, PRELOAD_DEADLINE_MS);
    let history: Awaited<ReturnType<typeof loadWebchatVoiceHistory>>;
    try {
      history = await loadWebchatVoiceHistory(
        sessionId,
        agentId,
        userId,
        this.identity.operatorId ?? null,
      );
    } catch {
      this.fail('Voice conversation could not be prepared.', 1011);
      return;
    }
    if (this.closed) return;
    const { context, userName } = loadVoiceCallContext(agentId, timeZone);
    const callerName = userName || (username === 'web' ? '' : username);
    this.bridge = new RealtimeCallBridge({
      connection: resolved.connection,
      config: voiceConfig,
      caller: { from: '', to: '', callerName },
      surface: 'web',
      context,
      history,
      onReady: () => {
        if (this.startTimer) {
          clearTimeout(this.startTimer);
          this.startTimer = null;
        }
        sendFrame(this.ws, { type: 'ready', sessionId });
        logger.info(
          { sessionId, remoteIp: this.remoteIp },
          'Webchat voice session started',
        );
      },
      audioFormat: { type: 'audio/pcm', rate: 24000 },
      sendAudio: async (base64Audio) => {
        sendFrame(this.ws, { type: 'audio', payload: base64Audio });
      },
      clearPlayback: async () => {
        sendFrame(this.ws, { type: 'clear' });
      },
      consultAgent: async (request, hooks) => {
        const result = await handleGatewayMessage({
          sessionId,
          guildId: null,
          channelId: 'web',
          userId,
          username,
          content: request,
          instructions: voiceConsultInstructions(timeZone),
          agentId,
          ...(client ? { client } : {}),
          abortSignal: hooks.abortSignal,
          onToolProgress: (event) => hooks.onToolProgress(event),
          source: 'webchat.voice',
        });
        if (result.status !== 'success') {
          throw new Error(result.error || 'Chat turn failed.');
        }
        return formatTextForVoice(result.result || '');
      },
      onConsultActivity: (label) => {
        sendFrame(this.ws, { type: 'consult', label });
      },
      onTranscript: (role, text) => {
        logger.debug(
          { sessionId, role, transcriptLength: text.length },
          'Webchat voice transcript',
        );
        const chatRole = role === 'caller' ? 'user' : 'assistant';
        persistVoiceTranscript({
          sessionId,
          channelId: 'web',
          agentId,
          userId,
          username,
          role: chatRole,
          text,
        });
        sendFrame(this.ws, { type: 'transcript', role: chatRole, text });
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
      ...(language ? { language } : {}),
    });
  }

  private fail(message: string, code: number, errorCode?: string): void {
    sendFrame(this.ws, {
      type: 'error',
      message,
      ...(errorCode ? { errorCode } : {}),
    });
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
