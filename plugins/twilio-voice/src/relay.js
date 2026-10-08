/**
 * ConversationRelay calls: Twilio transcribes the caller and speaks our text,
 * and each completed caller utterance becomes one gateway turn whose reply
 * streams back as sentence-sized `text` tokens while the model writes it.
 *
 * One turn runs per call at a time: a new prompt or a caller interruption
 * aborts the turn in flight. A dropped relay socket keeps the call (and any
 * running turn) alive so Twilio's reconnect can resume it; the action
 * callback in `runtime.js` decides when the call is really over.
 */
import {
  ConversationRelayResponseStream,
  mergePromptFragment,
  parseConversationRelayMessage,
} from './conversation-relay.js';
import { createSpeechChunker, normalizeCallerSpeech } from './text.js';

const WS_OPEN = 1;
const NO_SPOKEN_RESPONSE = 'I do not have a spoken response yet.';
const TURN_FAILED_REPLY =
  'Sorry, something went wrong while I was answering that.';
const RELAY_DISCONNECTED = 'Voice websocket is not connected.';

function isRelayDisconnected(error) {
  return error instanceof Error && error.message === RELAY_DISCONNECTED;
}

function sendJson(ws, payload) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(payload), (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function decodeCloseReason(reason) {
  const decoded = Buffer.isBuffer(reason)
    ? reason.toString('utf8').trim()
    : String(reason || '').trim();
  return decoded || '<empty>';
}

/** What a turn says when it streamed nothing: the approval prompt or the reply. */
function spokenResult(result) {
  const approval = result.pendingApproval;
  if (approval?.approvalId) {
    return [
      approval.intent?.trim() &&
        `Approval needed for: ${approval.intent.trim()}`,
      approval.reason?.trim() && `Why: ${approval.reason.trim()}`,
      `Approval ID: ${approval.approvalId}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return String(result.result || '');
}

export function createRelayCalls({ api, sessions, transition, agentId }) {
  const logger = api.logger;

  async function runAgentTurn(
    session,
    content,
    signal,
    responseStream,
    language,
  ) {
    const chunker = createSpeechChunker((text) =>
      api.formatTextForSpeech(text),
    );
    let streamedText = false;
    const speak = (chunk) => {
      streamedText = true;
      return responseStream.push(chunk);
    };
    const result = await api.dispatchInboundMessage({
      sessionId: session.gatewaySessionId,
      sessionMode: 'resume',
      guildId: null,
      channelId: session.channelId,
      userId: session.userId,
      username: session.username,
      content: normalizeCallerSpeech(content),
      agentId,
      abortSignal: signal,
      onTextDelta: (delta) => {
        for (const chunk of chunker.push(delta)) {
          speak(chunk).catch((error) => {
            if (signal.aborted || isRelayDisconnected(error)) return;
            logger.debug(
              { error, callSid: session.callSid },
              'Twilio relay text streaming failed',
            );
          });
        }
      },
      onProactiveMessage: (message) => {
        logger.debug(
          {
            callSid: session.callSid,
            artifactCount: message.artifacts?.length || 0,
          },
          'Skipping proactive message during a phone call',
        );
      },
    });
    if (result.status === 'error') {
      logger.warn(
        { callSid: session.callSid, error: result.error },
        'Twilio relay turn failed',
      );
      await responseStream.reply(TURN_FAILED_REPLY, { language });
      return;
    }
    for (const chunk of chunker.flush()) await speak(chunk);
    if (streamedText) return;
    const text = api.formatTextForSpeech(spokenResult(result));
    if (text) await responseStream.reply(text, { language });
  }

  async function dispatchPrompt(session, content, language) {
    if (!session.ws) return;
    const settings = api.getVoiceConfig();
    session.controller?.abort();
    const controller = new AbortController();
    session.controller = controller;
    transition(session.callSid, 'thinking');
    const responseStream = new ConversationRelayResponseStream(
      async (payload) => {
        if (controller.signal.aborted) return;
        if (!session.ws || session.ws.readyState !== WS_OPEN) {
          throw new Error(RELAY_DISCONNECTED);
        }
        await sendJson(session.ws, payload);
      },
      {
        interruptible: settings.relay.interruptible,
        language,
        onFirstToken: () => transition(session.callSid, 'speaking'),
        onFinished: () => {
          if (!controller.signal.aborted) {
            transition(session.callSid, 'listening');
          }
        },
      },
    );
    try {
      await runAgentTurn(
        session,
        content,
        controller.signal,
        responseStream,
        language,
      );
      if (!controller.signal.aborted && !responseStream.finished) {
        if (responseStream.hasEmittedText) {
          await responseStream.finish({ language });
        } else {
          await responseStream.reply(NO_SPOKEN_RESPONSE, { language });
        }
      }
    } catch (error) {
      if (controller.signal.aborted || isRelayDisconnected(error)) {
        logger.debug(
          { callSid: session.callSid },
          'Twilio relay turn aborted after relay disconnect',
        );
        return;
      }
      logger.warn(
        { error, callSid: session.callSid },
        'Twilio relay turn failed',
      );
      if (!responseStream.finished) {
        await responseStream
          .reply(TURN_FAILED_REPLY, { language })
          .catch((replyError) => {
            if (
              !controller.signal.aborted &&
              !isRelayDisconnected(replyError)
            ) {
              logger.debug(
                { error: replyError, callSid: session.callSid },
                'Twilio relay failure reply could not be sent',
              );
            }
          });
      }
    } finally {
      if (session.controller === controller) session.controller = null;
    }
  }

  const MESSAGE_HANDLERS = {
    async prompt(session, message, language) {
      const merged = mergePromptFragment(
        session.promptBuffer,
        message.voicePrompt,
      );
      session.promptBuffer = merged;
      if (!message.last) {
        transition(session.callSid, 'listening');
        return;
      }
      session.promptBuffer = '';
      await dispatchPrompt(session, merged, message.lang || language);
    },
    async dtmf(session, message, language) {
      logger.info(
        { callSid: session.callSid, digit: message.digit },
        'Twilio relay DTMF received',
      );
      await dispatchPrompt(
        session,
        `The caller pressed the keypad digit "${message.digit}".`,
        language,
      );
    },
    async interrupt(session, message) {
      logger.info(
        {
          callSid: session.callSid,
          durationUntilInterruptMs: message.durationUntilInterruptMs,
        },
        'Twilio relay interrupted',
      );
      session.controller?.abort();
      transition(session.callSid, 'interrupted');
    },
    async error(session, message) {
      logger.warn(
        { callSid: session.callSid, description: message.description },
        'ConversationRelay reported an error',
      );
      transition(session.callSid, 'failed');
    },
  };

  function handleConnection(ws, remoteIp, { isStopping }) {
    let callSid = null;

    ws.on('message', (raw) => {
      void (async () => {
        try {
          const message = parseConversationRelayMessage(raw);
          if (message.type === 'setup') {
            const settings = api.getVoiceConfig();
            const session = sessions.getOrCreate(
              {
                callSid: message.callSid,
                remoteIp,
                from: message.from,
                to: message.to,
                callerName: message.callerName,
              },
              settings.maxConcurrentCalls,
            );
            if (!session) {
              await sendJson(ws, {
                type: 'end',
                handoffData: JSON.stringify({ reason: 'capacity-exceeded' }),
              });
              ws.close();
              return;
            }
            session.ws = ws;
            callSid = message.callSid;
            logger.info(
              {
                callSid,
                remoteIp,
                direction: message.direction || '',
              },
              'Twilio relay setup received',
            );
            transition(callSid, 'listening');
            return;
          }
          if (!callSid) {
            throw new Error('ConversationRelay message arrived before setup.');
          }
          const session = sessions.get(callSid);
          if (!session) throw new Error(`Unknown voice call ${callSid}`);
          await MESSAGE_HANDLERS[message.type](
            session,
            message,
            api.getVoiceConfig().relay.language,
          );
        } catch (error) {
          logger.warn(
            { error, callSid, remoteIp },
            'Twilio relay message failed',
          );
          if (callSid) transition(callSid, 'failed');
          if (ws.readyState === WS_OPEN) {
            ws.close(1008, 'Invalid voice relay message');
          }
        }
      })();
    });

    ws.on('close', (code, reason) => {
      logger.info(
        { callSid, remoteIp, code, reason: decodeCloseReason(reason) },
        'Twilio relay websocket closed',
      );
      const session = callSid ? sessions.get(callSid) : undefined;
      if (!session) return;
      // A relay close can be transient; keep the active turn alive so a
      // reconnect does not kill the model/container mid-request.
      session.ws = null;
      if (
        !isStopping() &&
        session.state !== 'ended' &&
        session.state !== 'failed'
      ) {
        transition(callSid, 'reconnecting');
      }
    });

    ws.on('error', (error) => {
      logger.debug(
        { error, callSid, remoteIp },
        'Twilio relay websocket error',
      );
    });
  }

  async function endCall(session) {
    if (!session.ws || session.ws.readyState !== WS_OPEN) return;
    await sendJson(session.ws, {
      type: 'end',
      handoffData: JSON.stringify({ reason: 'gateway-shutdown' }),
    }).catch((error) => {
      logger.debug(
        { error, callSid: session.callSid },
        'Twilio relay end failed',
      );
    });
    session.ws.close();
  }

  return { handleConnection, endCall };
}
