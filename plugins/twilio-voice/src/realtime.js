/**
 * Realtime calls: Twilio Media Streams carry the caller's µ-law audio to a
 * core realtime voice session (`api.createRealtimeVoiceSession`) and the
 * model's audio back, with `clear` frames for barge-in.
 *
 * The stream's `start` frame names the call through the `callReference`
 * parameter our TwiML set, so only a call this plugin answered can attach
 * a stream. Losing the realtime upstream ends the stream rather than leaving
 * the caller in silence. NOT the agent turn: consults, approvals, and
 * transcripts are the core session's job.
 */
import {
  buildClearPayload,
  buildMediaPayload,
  parseMediaStreamMessage,
} from './media-stream.js';

const WS_OPEN = 1;

function sendJson(ws, payload) {
  if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(payload));
}

export function createRealtimeCalls({ api, sessions, transition }) {
  const logger = api.logger;

  function teardown(callSid, next) {
    const session = sessions.get(callSid);
    if (!session) return;
    session.realtime?.close();
    session.realtime = null;
    transition(callSid, next);
    sessions.remove(callSid);
  }

  function attachStream(ws, message, remoteIp) {
    const reference =
      message.customParameters?.callReference || message.callSid;
    const session = reference ? sessions.get(reference) : undefined;
    if (!session) {
      throw new Error(
        `Media stream started for unknown voice call ${reference || 'unknown'}`,
      );
    }
    const { streamSid } = message;
    session.ws = ws;
    session.realtime = api.createRealtimeVoiceSession({
      caller: {
        from: session.from,
        to: session.to,
        callerName: session.callerName,
      },
      session: {
        sessionId: session.gatewaySessionId,
        channelId: session.channelId,
        userId: session.userId,
        username: session.username,
      },
      audioEncoding: 'mulaw',
      sendAudio: (frame) =>
        sendJson(ws, buildMediaPayload(streamSid, frame.toString('base64'))),
      clearAudio: () => sendJson(ws, buildClearPayload(streamSid)),
      onStateChange: (state) => transition(session.callSid, state),
      onError: (errorMessage) => {
        logger.warn(
          { callSid: session.callSid, errorMessage },
          'Twilio realtime session error',
        );
      },
      onClosed: () => {
        if (ws.readyState === WS_OPEN) ws.close();
      },
    });
    transition(session.callSid, 'listening');
    logger.info(
      { callSid: session.callSid, streamSid, remoteIp },
      'Twilio media stream started',
    );
    return session.callSid;
  }

  function handleConnection(ws, remoteIp) {
    let callSid = null;

    ws.on('message', (raw) => {
      try {
        const message = parseMediaStreamMessage(raw);
        if (message.type === 'connected' || message.type === 'mark') return;
        if (message.type === 'start') {
          callSid = attachStream(ws, message, remoteIp);
          return;
        }
        if (!callSid)
          throw new Error('Media stream frame arrived before start.');
        const realtime = sessions.get(callSid)?.realtime;
        if (!realtime) throw new Error(`Unknown voice call ${callSid}`);
        if (message.type === 'media') {
          realtime.handleCallerAudio(Buffer.from(message.payload, 'base64'));
          return;
        }
        if (message.type === 'dtmf') {
          logger.info(
            { callSid, digit: message.digit },
            'Twilio media stream DTMF received',
          );
          realtime.handleDtmf(message.digit);
          return;
        }
        logger.info({ callSid }, 'Twilio media stream stopped');
        teardown(callSid, 'ended');
      } catch (error) {
        logger.warn(
          { error, callSid, remoteIp },
          'Twilio media stream message failed',
        );
        if (callSid) teardown(callSid, 'failed');
        if (ws.readyState === WS_OPEN) {
          ws.close(1008, 'Invalid voice media stream message');
        }
      }
    });

    ws.on('close', (code) => {
      logger.info(
        { callSid, remoteIp, code },
        'Twilio media stream websocket closed',
      );
      if (callSid) teardown(callSid, 'ended');
    });

    ws.on('error', (error) => {
      logger.debug(
        { error, callSid, remoteIp },
        'Twilio media stream websocket error',
      );
    });
  }

  return { handleConnection, teardown };
}
