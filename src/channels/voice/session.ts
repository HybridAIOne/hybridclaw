import type WebSocket from 'ws';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { buildSessionKey } from '../../session/session-key.js';
import { buildVoiceChannelId } from './channel-id.js';
import type { ConversationRelaySetupMessage } from './conversation-relay.js';

export type VoiceCallState =
  | 'initiated'
  | 'twiml-issued'
  | 'relay-connecting'
  | 'setup-received'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'reconnecting'
  | 'ending'
  | 'ended'
  | 'failed';

const TERMINAL_STATES = new Set<VoiceCallState>(['ended', 'failed']);
const ALLOWED_TRANSITIONS: Record<VoiceCallState, VoiceCallState[]> = {
  initiated: ['twiml-issued', 'relay-connecting', 'failed'],
  'twiml-issued': ['relay-connecting', 'failed'],
  'relay-connecting': ['setup-received', 'failed', 'reconnecting'],
  'setup-received': ['listening', 'failed'],
  listening: ['thinking', 'interrupted', 'ending', 'failed', 'reconnecting'],
  thinking: ['speaking', 'interrupted', 'ending', 'failed', 'reconnecting'],
  speaking: ['listening', 'interrupted', 'ending', 'failed', 'reconnecting'],
  interrupted: ['listening', 'thinking', 'ending', 'failed', 'reconnecting'],
  reconnecting: ['relay-connecting', 'failed', 'ended'],
  ending: ['ended', 'failed'],
  ended: [],
  failed: [],
};

export interface VoiceCallSession {
  callSid: string;
  twilioSessionId: string | null;
  channelId: string;
  gatewaySessionId: string;
  remoteIp: string;
  from: string;
  to: string;
  userId: string;
  username: string;
  callerName: string;
  state: VoiceCallState;
  promptBuffer: string;
  reconnectAttempts: number;
  actionCallbacks: number;
  ws: WebSocket | null;
  controller: AbortController | null;
  setupMessage: ConversationRelaySetupMessage | null;
  createdAt: number;
  updatedAt: number;
}

function now(): number {
  return Date.now();
}

function buildGatewaySessionId(callSid: string): string {
  return buildSessionKey(DEFAULT_AGENT_ID, 'voice', 'dm', callSid);
}

function createSession(params: {
  callSid: string;
  remoteIp: string;
  from: string;
  to: string;
  userId: string;
  username: string;
  callerName?: string;
}): VoiceCallSession {
  const timestamp = now();
  return {
    callSid: params.callSid,
    twilioSessionId: null,
    channelId: buildVoiceChannelId(params.callSid),
    gatewaySessionId: buildGatewaySessionId(params.callSid),
    remoteIp: params.remoteIp,
    from: params.from,
    to: params.to,
    userId: params.userId,
    username: params.username,
    callerName: params.callerName || '',
    state: 'initiated',
    promptBuffer: '',
    reconnectAttempts: 0,
    actionCallbacks: 0,
    ws: null,
    controller: null,
    setupMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class VoiceCallSessionStore {
  private readonly sessions = new Map<string, VoiceCallSession>();
  private readonly pendingConnectionsByIp = new Map<string, number>();

  constructor(
    private maxConcurrentCalls: number,
    private readonly maxPendingConnections: number,
    private readonly maxConnectionsPerIp: number,
  ) {}

  updateLimits(maxConcurrentCalls: number): void {
    this.maxConcurrentCalls = Math.max(1, maxConcurrentCalls);
  }

  activeCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!TERMINAL_STATES.has(session.state)) {
        count += 1;
      }
    }
    return count;
  }

  get(callSid: string): VoiceCallSession | undefined {
    return this.sessions.get(callSid);
  }

  list(): VoiceCallSession[] {
    return Array.from(this.sessions.values());
  }

  getOrCreateFromWebhook(params: {
    callSid: string;
    remoteIp: string;
    from: string;
    to: string;
    callerName?: string;
  }): VoiceCallSession | null {
    const existing = this.sessions.get(params.callSid);
    if (existing) {
      existing.remoteIp = params.remoteIp;
      existing.from = params.from;
      existing.to = params.to;
      existing.userId = params.from || params.callSid;
      existing.username = params.callerName || params.from || params.callSid;
      existing.callerName = params.callerName || existing.callerName;
      existing.updatedAt = now();
      return existing;
    }
    if (this.activeCount() >= this.maxConcurrentCalls) {
      return null;
    }
    const session = createSession({
      callSid: params.callSid,
      remoteIp: params.remoteIp,
      from: params.from,
      to: params.to,
      userId: params.from || params.callSid,
      username: params.callerName || params.from || params.callSid,
      callerName: params.callerName,
    });
    this.sessions.set(params.callSid, session);
    return session;
  }

  attachSetup(params: {
    setup: ConversationRelaySetupMessage;
    remoteIp: string;
    ws: WebSocket;
  }): VoiceCallSession | null {
    const setup = params.setup;
    const existing =
      this.sessions.get(setup.callSid) ||
      this.getOrCreateFromWebhook({
        callSid: setup.callSid,
        remoteIp: params.remoteIp,
        from: setup.from,
        to: setup.to,
        callerName: setup.callerName,
      });
    if (!existing) {
      return null;
    }
    existing.twilioSessionId = setup.sessionId;
    existing.remoteIp = params.remoteIp;
    existing.from = setup.from;
    existing.to = setup.to;
    existing.userId = setup.from || setup.callSid;
    existing.username = setup.callerName || setup.from || setup.callSid;
    existing.callerName = setup.callerName || existing.callerName;
    existing.setupMessage = setup;
    existing.ws = params.ws;
    existing.updatedAt = now();
    return existing;
  }

  bufferPrompt(callSid: string, content: string): VoiceCallSession | undefined {
    const session = this.sessions.get(callSid);
    if (!session) return undefined;
    session.promptBuffer = content;
    session.updatedAt = now();
    return session;
  }

  clearPrompt(callSid: string): void {
    const session = this.sessions.get(callSid);
    if (!session) return;
    session.promptBuffer = '';
    session.updatedAt = now();
  }

  setController(callSid: string, controller: AbortController | null): void {
    const session = this.sessions.get(callSid);
    if (!session) return;
    session.controller = controller;
    session.updatedAt = now();
  }

  transition(callSid: string, next: VoiceCallState): VoiceCallSession {
    const session = this.sessions.get(callSid);
    if (!session) {
      throw new Error(`Unknown voice call session: ${callSid}`);
    }
    if (session.state === next) {
      return session;
    }
    const allowed = ALLOWED_TRANSITIONS[session.state];
    if (!allowed.includes(next)) {
      throw new Error(
        `Invalid voice session state transition: ${session.state} -> ${next}`,
      );
    }
    session.state = next;
    session.updatedAt = now();
    return session;
  }

  markReconnectAttempt(callSid: string): VoiceCallSession | undefined {
    const session = this.sessions.get(callSid);
    if (!session) return undefined;
    session.reconnectAttempts += 1;
    session.updatedAt = now();
    return session;
  }

  markActionCallback(callSid: string): VoiceCallSession | undefined {
    const session = this.sessions.get(callSid);
    if (!session) return undefined;
    session.actionCallbacks += 1;
    session.updatedAt = now();
    return session;
  }

  remove(callSid: string): void {
    this.sessions.delete(callSid);
  }

  beginPendingConnection(remoteIp: string): boolean {
    const normalizedIp = String(remoteIp || '').trim() || 'unknown';
    let totalPending = 0;
    for (const count of this.pendingConnectionsByIp.values()) {
      totalPending += count;
    }
    const ipPending = this.pendingConnectionsByIp.get(normalizedIp) || 0;
    if (
      totalPending >= this.maxPendingConnections ||
      ipPending >= this.maxConnectionsPerIp
    ) {
      return false;
    }
    this.pendingConnectionsByIp.set(normalizedIp, ipPending + 1);
    return true;
  }

  endPendingConnection(remoteIp: string): void {
    const normalizedIp = String(remoteIp || '').trim() || 'unknown';
    const count = this.pendingConnectionsByIp.get(normalizedIp) || 0;
    if (count <= 1) {
      this.pendingConnectionsByIp.delete(normalizedIp);
      return;
    }
    this.pendingConnectionsByIp.set(normalizedIp, count - 1);
  }
}
