/**
 * Realtime speech-to-speech voice sessions for channel plugins.
 *
 * Wraps the core `RealtimeCallBridge` behind a telephony transport contract:
 * plugins hand in 8 kHz mono caller audio — 16-bit LE PCM by default, or
 * G.711 µ-law for transports that carry it natively (Twilio Media Streams) —
 * and receive model audio back as 20 ms frames in the same encoding the
 * moment the model produces them, so nothing on our
 * side sits between the model and the caller. The far end (Vonage buffers
 * about 60 s of websocket audio) plays in order, so only a bounded window is
 * kept in flight and the rest is released as playback advances; barge-in
 * drops the local queue and asks the transport to clear what the far end has
 * buffered. µ-law companding to the realtime session's `audio/pcmu` is exact
 * per-sample and skipped entirely for µ-law transports; no resampling happens
 * anywhere.
 *
 * Consults run through the plugin inbound-message dispatcher, so approvals,
 * audit, and session history behave exactly like the plugin's turn-based
 * path, and spoken turns persist as voice transcripts.
 *
 * NOT a transport: websocket framing, peer auth, and call signaling stay in
 * the plugin; this module never sees raw transport messages.
 */

import { getConfigSnapshot } from '../config/config.js';
import type { GatewayChatResult } from '../gateway/gateway-types.js';
import { persistVoiceTranscript } from '../gateway/voice-transcript-store.js';
import { logger } from '../logger.js';
import { muLawToPcm16, pcm16ToMuLaw } from '../voice/audio-codec.js';
import type { RealtimeSocketFactory } from '../voice/openai-realtime.js';
import {
  RealtimeCallBridge,
  resolvePhoneRealtimeConfig,
} from '../voice/realtime-bridge.js';
import {
  isRealtimeCredentialConfigured,
  resolveRealtimeConnection,
} from '../voice/realtime-credentials.js';
import { formatTextForVoice } from '../voice/text.js';
import type {
  PluginDispatchInboundMessageRequest,
  PluginRealtimeVoiceSession,
  PluginRealtimeVoiceSessionOptions,
} from './plugin-types.js';

const FRAME_INTERVAL_MS = 20;
// 20 ms at 8 kHz: 320 bytes as 16-bit PCM, 160 one-byte µ-law samples.
const FRAME_BYTES = { pcm16: 320, mulaw: 160 } as const;
// Padding a short tail must stay silent: µ-law encodes zero amplitude as 0xff.
const SILENCE_BYTE = { pcm16: 0x00, mulaw: 0xff } as const;
// Audio in flight at the far end is capped well under Vonage's ~60 s websocket
// buffer; anything beyond is released as playback advances.
const SEND_AHEAD_MS = 20_000;
const DRAIN_TICK_MS = 20;
// 60ms (PR #1395 call, 2026-08-19): a response tail shorter than one frame is
// padded out with silence after a short lull rather than waiting for the next
// response.
const PARTIAL_FLUSH_AFTER_MS = 60;
// ~5 min of queued model audio; realtime responses burst faster than
// playback, so long relayed replies queue — but never this much.
const MAX_QUEUED_FRAMES = 300_000 / FRAME_INTERVAL_MS;

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
  const voiceConfig = resolvePhoneRealtimeConfig(getConfigSnapshot());
  const resolved = resolveRealtimeConnection(voiceConfig.provider);
  if (!resolved.connection) {
    throw new Error(resolved.error);
  }
  const identity = options.session;
  const encoding = options.audioEncoding ?? 'pcm16';
  if (!Object.hasOwn(FRAME_BYTES, encoding)) {
    throw new Error(`Unsupported realtime voice audio encoding: ${encoding}`);
  }
  const frameBytes = FRAME_BYTES[encoding];
  const maxQueuedBytes = frameBytes * MAX_QUEUED_FRAMES;

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
    const out = Buffer.alloc(frameBytes, SILENCE_BYTE[encoding]);
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
    if (queuedBytes < frameBytes) return null;
    const head = queued[0];
    if (head.length - headOffset >= frameBytes) {
      const frame = head.subarray(headOffset, headOffset + frameBytes);
      headOffset += frameBytes;
      if (headOffset === head.length) {
        queued.shift();
        headOffset = 0;
      }
      queuedBytes -= frameBytes;
      return frame;
    }
    return takeBytes(frameBytes);
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
    config: voiceConfig,
    caller: {
      from: options.caller.from,
      to: options.caller.to,
      callerName: options.caller.callerName || '',
    },
    surface: 'phone',
    audioFormat: { type: 'audio/pcmu' },
    sendAudio: async (base64Audio) => {
      if (closed) return;
      const modelAudio = Buffer.from(base64Audio, 'base64');
      const audio =
        encoding === 'mulaw' ? modelAudio : muLawToPcm16(modelAudio);
      if (audio.length === 0) return;
      if (queuedBytes + audio.length > maxQueuedBytes) {
        logger.warn(
          { pluginId: deps.pluginId },
          'Plugin realtime voice playback queue overflow; dropping audio',
        );
        return;
      }
      queued.push(audio);
      queuedBytes += audio.length;
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
      bridge.handleCallerAudio(
        (encoding === 'mulaw' ? frame : pcm16ToMuLaw(frame)).toString('base64'),
      );
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
