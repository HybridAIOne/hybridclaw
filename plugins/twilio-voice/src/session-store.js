/**
 * Live Twilio calls keyed by CallSid, with the per-call state machine and the
 * concurrency count `voice.maxConcurrentCalls` is enforced against.
 *
 * A call counts toward capacity until it reaches a terminal state (`ended`,
 * `failed`) or is removed; illegal transitions throw so a protocol bug shows
 * up in the log instead of silently corrupting the count. Holds sockets and
 * abort controllers, which die with the plugin runtime.
 */
import { buildVoiceSessionKey } from './utils.js';

const TERMINAL_STATES = new Set(['ended', 'failed']);
const ALLOWED_TRANSITIONS = {
  initiated: ['twiml-issued', 'relay-connecting', 'listening', 'failed'],
  'twiml-issued': ['relay-connecting', 'listening', 'failed'],
  'relay-connecting': ['listening', 'failed', 'reconnecting'],
  // Realtime mode speaks without a preceding gateway turn and consults the
  // agent mid-speech, so listening -> speaking and speaking -> thinking are
  // legal in addition to the relay-mode cycle.
  listening: [
    'thinking',
    'speaking',
    'interrupted',
    'ending',
    'failed',
    'reconnecting',
  ],
  thinking: ['speaking', 'interrupted', 'ending', 'failed', 'reconnecting'],
  speaking: [
    'listening',
    'thinking',
    'interrupted',
    'ending',
    'failed',
    'reconnecting',
  ],
  interrupted: ['listening', 'thinking', 'ending', 'failed', 'reconnecting'],
  reconnecting: ['relay-connecting', 'failed', 'ended'],
  ending: ['ended', 'failed'],
  ended: [],
  failed: [],
};

function applyCaller(session, { from, to, callerName }) {
  session.from = from;
  session.to = to;
  session.callerName = callerName || session.callerName;
  session.userId = from || session.callSid;
  session.username = callerName || from || session.callSid;
}

export function createSessionStore({ agentId }) {
  const sessions = new Map();
  let activeCount = 0;

  return {
    get: (callSid) => sessions.get(callSid),
    list: () => [...sessions.values()],
    activeCount: () => activeCount,

    /** Null when a new call would exceed `maxConcurrentCalls`. */
    getOrCreate(
      { callSid, remoteIp, from, to, callerName },
      maxConcurrentCalls,
    ) {
      const existing = sessions.get(callSid);
      if (existing) {
        existing.remoteIp = remoteIp;
        applyCaller(existing, { from, to, callerName });
        return existing;
      }
      if (activeCount >= maxConcurrentCalls) return null;
      const session = {
        callSid,
        channelId: `voice:${callSid}`,
        gatewaySessionId: buildVoiceSessionKey(agentId, callSid),
        remoteIp,
        callerName: '',
        state: 'initiated',
        promptBuffer: '',
        reconnectAttempts: 0,
        ws: null,
        controller: null,
        realtime: null,
      };
      applyCaller(session, { from, to, callerName });
      sessions.set(callSid, session);
      activeCount += 1;
      return session;
    },

    transition(callSid, next) {
      const session = sessions.get(callSid);
      if (!session) throw new Error(`Unknown voice call session: ${callSid}`);
      if (session.state === next) return session;
      if (!ALLOWED_TRANSITIONS[session.state].includes(next)) {
        throw new Error(
          `Invalid voice session state transition: ${session.state} -> ${next}`,
        );
      }
      if (!TERMINAL_STATES.has(session.state) && TERMINAL_STATES.has(next)) {
        activeCount = Math.max(0, activeCount - 1);
      }
      session.state = next;
      return session;
    },

    remove(callSid) {
      const session = sessions.get(callSid);
      if (!session) return;
      if (!TERMINAL_STATES.has(session.state)) {
        activeCount = Math.max(0, activeCount - 1);
      }
      sessions.delete(callSid);
    },
  };
}
