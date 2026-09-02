/**
 * Realtime speech-to-speech voice sessions for channel plugins.
 *
 * Wraps the core `RealtimeCallBridge` behind a linear-PCM transport contract:
 * plugins hand in 16-bit LE mono 8 kHz caller audio and receive model audio
 * back as 20 ms frames the moment the model produces them, so nothing on our
 * side sits between the model and the caller. The far end (Vonage buffers
 * about 60 s of websocket audio) plays in order, so only a bounded window is
 * kept in flight and the rest is released as playback advances; barge-in
 * drops the local queue and asks the transport to clear what the far end has
 * buffered. µ-law companding to the realtime session's `audio/pcmu` is exact
 * per-sample; no resampling happens anywhere.
 *
 * Consults run through the plugin inbound-message dispatcher, so approvals,
 * audit, and session history behave exactly like the plugin's turn-based
 * path, and spoken turns persist as voice transcripts.
 *
 * NOT a transport: websocket framing, peer auth, and call signaling stay in
 * the plugin; this module never sees raw transport messages.
 */
import { muLawToPcm16, pcm16ToMuLaw } from '../channels/voice/audio-codec.js';
import type { RealtimeSocketFactory } from '../channels/voice/openai-realtime.js';
import { RealtimeCallBridge } from '../channels/voice/realtime-bridge.js';
import {
  isRealtimeCredentialConfigured,
  resolveRealtimeConnection,
} from '../channels/voice/realtime-credentials.js';
import { formatTextForVoice } from '../channels/voice/text.js';
import { getConfigSnapshot } from '../config/config.js';
import type { GatewayChatResult } from '../gateway/gateway-types.js';
import { persistVoiceTranscript } from '../gateway/voice-transcript-store.js';
import { logger } from '../logger.js';
import type {
  PluginDispatchInboundMessageRequest,
  PluginRealtimeVoiceSession,
  PluginRealtimeVoiceSessionOptions,
} from './plugin-types.js';

const FRAME_BYTES = 320; // 20 ms of 16-bit mono at 8 kHz
const FRAME_INTERVAL_MS = 20;
// Audio in flight at the far end is capped well under Vonage's ~60 s websocket
// buffer; anything beyond is released as playback advances.
const SEND_AHEAD_MS = 20_000;
const DRAIN_TICK_MS = 20;
// 60ms (PR #1395 call, 2026-08-19): a response tail shorter than one frame is
// zero-padded out after a short lull rather than waiting for the next response.
const PARTIAL_FLUSH_AFTER_MS = 60;
// ~5 min of queued model audio (~4.8 MB as PCM16); realtime responses burst
// faster than playback, so long relayed replies queue — but never this much.
const MAX_QUEUED_BYTES = 8_000 * 2 * 300;

export interface PluginRealtimeVoiceDeps {
  pluginId: string;
  agentId: string;
  dispatch: (
    request: PluginDispatchInboundMessageRequest,
  ) => Promise<GatewayChatResult>;
  /** Test seam: injected upstream realtime socket factory. */
  socketFactory?: RealtimeSocketFactory;
}

export function isPluginRealtimeVoiceAvailable(): boolean {
  return isRealtimeCredentialConfigured(
    getConfigSnapshot().speech.realtime.provider,
  );
}

export function createPluginRealtimeVoiceSession(
  options: PluginRealtimeVoiceSessionOptions,
  deps: PluginRealtimeVoiceDeps,
): PluginRealtimeVoiceSession {
  const voiceConfig = getConfigSnapshot().speech.realtime;
  const resolved = resolveRealtimeConnection(voiceConfig.provider);
  if (!resolved.connection) {
    throw new Error(resolved.error);
  }
  const greeting = String(options.greeting || '').trim();
  const identity = options.session;

  let queued: Buffer[] = [];
  let headOffset = 0;
  let queuedBytes = 0;
  let lastAppendAt = 0;
  let playheadAt = 0;
  let closed = false;

  const sendFrame = (frame: Buffer): void => {
    try {
      options.sendAudio(frame);
    } catch (error) {
      logger.debug(
        { pluginId: deps.pluginId, error },
        'Plugin realtime voice sendAudio failed',
      );
    }
  };

  const takeBytes = (count: number): Buffer => {
    const out = Buffer.alloc(FRAME_BYTES);
    let filled = 0;
    while (filled < count) {
      const chunk = queued[0];
      const take = Math.min(count - filled, chunk.length - headOffset);
      chunk.copy(out, filled, headOffset, headOffset + take);
      filled += take;
      headOffset += take;
      if (headOffset === chunk.length) {
        queued.shift();
        headOffset = 0;
      }
    }
    queuedBytes -= count;
    return out;
  };

  const takeFrame = (): Buffer | null => {
    if (queuedBytes < FRAME_BYTES) return null;
    const head = queued[0];
    if (head.length - headOffset >= FRAME_BYTES) {
      const frame = head.subarray(headOffset, headOffset + FRAME_BYTES);
      headOffset += FRAME_BYTES;
      if (headOffset === head.length) {
        queued.shift();
        headOffset = 0;
      }
      queuedBytes -= FRAME_BYTES;
      return frame;
    }
    return takeBytes(FRAME_BYTES);
  };

  const clearQueue = (): void => {
    queued = [];
    headOffset = 0;
    queuedBytes = 0;
    playheadAt = 0;
  };

  const drain = (): void => {
    const now = Date.now();
    if (playheadAt < now) playheadAt = now;
    while (queuedBytes > 0 && playheadAt - now < SEND_AHEAD_MS) {
      const frame = takeFrame();
      if (frame) {
        sendFrame(frame);
      } else {
        if (now - lastAppendAt < PARTIAL_FLUSH_AFTER_MS) return;
        sendFrame(takeBytes(queuedBytes));
      }
      playheadAt += FRAME_INTERVAL_MS;
    }
  };

  const pacer = setInterval(drain, DRAIN_TICK_MS);

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pacer);
    clearQueue();
  };

  const bridge = new RealtimeCallBridge({
    connection: resolved.connection,
    config: greeting ? { ...voiceConfig, greeting } : voiceConfig,
    caller: {
      from: options.caller.from,
      to: options.caller.to,
      callerName: options.caller.callerName || '',
    },
    surface: 'phone',
    audioFormat: { type: 'audio/pcmu' },
    sendAudio: async (base64Audio) => {
      if (closed) return;
      const pcm = muLawToPcm16(Buffer.from(base64Audio, 'base64'));
      if (pcm.length === 0) return;
      if (queuedBytes + pcm.length > MAX_QUEUED_BYTES) {
        logger.warn(
          { pluginId: deps.pluginId },
          'Plugin realtime voice playback queue overflow; dropping audio',
        );
        return;
      }
      queued.push(pcm);
      queuedBytes += pcm.length;
      lastAppendAt = Date.now();
      drain();
    },
    clearPlayback: async () => {
      clearQueue();
      options.clearAudio?.();
    },
    consultAgent: async (request, hooks) => {
      const result = await deps.dispatch({
        sessionId: identity.sessionId,
        sessionMode: 'resume',
        guildId: null,
        channelId: identity.channelId,
        userId: identity.userId,
        username: identity.username,
        content: request,
        agentId: deps.agentId,
        abortSignal: hooks.abortSignal,
        onToolProgress: (event) => hooks.onToolProgress(event),
      });
      if (result.status !== 'success') {
        throw new Error(result.error || 'Agent turn failed.');
      }
      return formatTextForVoice(result.result || '');
    },
    onTranscript: (role, text) => {
      logger.debug(
        {
          pluginId: deps.pluginId,
          sessionId: identity.sessionId,
          role,
          transcriptLength: text.length,
        },
        'Plugin realtime voice transcript',
      );
      persistVoiceTranscript({
        sessionId: identity.sessionId,
        channelId: identity.channelId,
        agentId: deps.agentId,
        userId: identity.userId,
        username: identity.username,
        role: role === 'caller' ? 'user' : 'assistant',
        text,
      });
    },
    onStateChange: (state) => {
      options.onStateChange?.(state);
    },
    onError: (message) => {
      logger.warn(
        { pluginId: deps.pluginId, sessionId: identity.sessionId, message },
        'Plugin realtime voice bridge error',
      );
      options.onError?.(message);
    },
    onClosed: () => {
      teardown();
      options.onClosed?.();
    },
    socketFactory: deps.socketFactory,
  });

  return {
    handleCallerAudio(frame: Buffer): void {
      if (closed || frame.length === 0) return;
      bridge.handleCallerAudio(pcm16ToMuLaw(frame).toString('base64'));
    },
    handleDtmf(digit: string): void {
      if (closed) return;
      bridge.handleDtmf(digit);
    },
    close(): void {
      teardown();
      bridge.close();
    },
    get isOpen(): boolean {
      return !closed && bridge.isOpen;
    },
  };
}
