/**
 * Realtime-mode websocket leg: pairs a Vonage `connect`-to-websocket call leg
 * with a core realtime voice session (api.createRealtimeVoiceSession).
 *
 * Upgrades authenticate with a single-use stream token minted by the answer
 * webhook — Vonage does not sign websocket upgrades, so possession of a
 * fresh token minted for that call is the auth. Binary frames are 16-bit LE
 * mono PCM at 8 kHz in both directions; the text frame `{"action":"clear"}`
 * drops audio Vonage has buffered but not yet played (barge-in).
 *
 * NOT the call-state owner: the answer/event webhooks in runtime.js own the
 * session table, capacity, and teardown signaling.
 */
import { randomBytes } from 'node:crypto';
import { buildVoiceSessionKey } from './utils.js';

const STREAM_TOKEN_TTL_MS = 30_000;
const WS_OPEN = 1;
const CLEAR_COMMAND = JSON.stringify({ action: 'clear' });

export function createVonageRealtimeStreams(api, config) {
  const tokens = new Map();
  const activeStreams = new Set();
  const agentId = api.config.agents?.defaultAgentId || 'main';

  function pruneTokens() {
    const now = Date.now();
    for (const [token, entry] of tokens) {
      if (entry.expiresAt <= now) tokens.delete(token);
    }
  }

  return {
    mintStreamToken(call) {
      pruneTokens();
      const token = randomBytes(24).toString('base64url');
      tokens.set(token, {
        call,
        expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
      });
      return token;
    },

    websocketUri(token) {
      const wsBase = config.publicBaseUrl.replace(/^https:\/\//i, 'wss://');
      return `${wsBase}/api/plugin-webhooks/vonage-voice/stream?token=${token}`;
    },

    async handleStreamUpgrade(ctx) {
      pruneTokens();
      const token = String(ctx.url.searchParams.get('token') || '');
      const entry = token ? tokens.get(token) : undefined;
      if (!entry) {
        ctx.logger.warn(
          { webhook: ctx.webhookName },
          'Vonage stream upgrade rejected: missing or stale token',
        );
        ctx.reject(401, 'Invalid stream token');
        return;
      }
      tokens.delete(token);
      const call = entry.call;
      const ws = await ctx.accept();
      let session;
      try {
        session = api.createRealtimeVoiceSession({
          caller: { from: call.from, to: call.to },
          session: {
            sessionId: buildVoiceSessionKey(agentId, call.uuid),
            channelId: `voice:${call.uuid}`,
            userId: call.from || call.uuid,
            username: call.from || call.uuid,
          },
          sendAudio: (frame) => {
            if (ws.readyState === WS_OPEN) ws.send(frame);
          },
          clearAudio: () => {
            if (ws.readyState === WS_OPEN) ws.send(CLEAR_COMMAND);
          },
          onError: (message) => {
            ctx.logger.warn(
              { callUuid: call.uuid, message },
              'Vonage realtime session error',
            );
          },
          onClosed: () => {
            ws.close();
          },
        });
      } catch (error) {
        ctx.logger.warn(
          { callUuid: call.uuid, error },
          'Vonage realtime session failed to start',
        );
        ws.close(1011, 'Realtime session unavailable');
        return;
      }
      const stream = { session, ws };
      activeStreams.add(stream);
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          session.handleCallerAudio(
            Buffer.isBuffer(data) ? data : Buffer.from(data),
          );
          return;
        }
        // Text frames are Vonage lifecycle events (websocket:connected,
        // websocket:cleared); nothing to act on.
      });
      ws.on('close', () => {
        activeStreams.delete(stream);
        session.close();
      });
      ws.on('error', (error) => {
        ctx.logger.warn(
          { callUuid: call.uuid, error },
          'Vonage stream websocket error',
        );
      });
    },

    stop() {
      tokens.clear();
      for (const stream of activeStreams) {
        stream.session.close();
        stream.ws.close();
      }
      activeStreams.clear();
    },
  };
}
