import { transferVonageCallToNcco } from './api.js';
import {
  extractBearerToken,
  verifyVonageWebhookJwt,
  WEBHOOK_JWT_MAX_AGE_SECONDS,
} from './jwt.js';
import {
  buildGoodbyeNcco,
  buildParkNcco,
  buildReplyNcco,
  parseVonageAnswerWebhook,
  parseVonageEventWebhook,
  parseVonageInputWebhook,
  VONAGE_TERMINAL_CALL_STATUSES,
} from './ncco.js';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SILENT_TIMEOUTS = 3;

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readRawJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { raw, body: JSON.parse(raw || '{}') };
  } catch {
    return null;
  }
}

function buildVoiceSessionKey(agentId, callUuid) {
  return [
    'agent',
    encodeURIComponent(agentId),
    'channel',
    'voice',
    'chat',
    'dm',
    'peer',
    encodeURIComponent(callUuid),
  ].join(':');
}

export function createVonageRuntime(api, config) {
  const sessions = new Map();
  const replayCache = new Map();
  const agentId = api.config.agents?.defaultAgentId || 'main';
  const webhookBase = `${config.publicBaseUrl}/api/plugin-webhooks/vonage-voice`;
  const inputEventUrl = `${webhookBase}/input`;

  function validateWebhook(ctx, rawBody) {
    const token = extractBearerToken(ctx.req.headers.authorization);
    const claims = verifyVonageWebhookJwt({
      token,
      signatureSecret: config.signatureSecret,
      rawBody,
    });
    if (!claims) return false;
    const now = Date.now();
    for (const [jti, expiresAt] of replayCache) {
      if (expiresAt <= now) replayCache.delete(jti);
    }
    if (replayCache.has(claims.jti)) return false;
    replayCache.set(claims.jti, now + WEBHOOK_JWT_MAX_AGE_SECONDS * 1_000);
    return true;
  }

  async function readSignedPayload(ctx) {
    const parsed = await readRawJson(ctx.req);
    if (!parsed) {
      sendJson(ctx.res, 400, { error: 'Invalid JSON payload.' });
      return null;
    }
    if (!validateWebhook(ctx, parsed.raw)) {
      ctx.logger.warn(
        { webhook: ctx.webhookName },
        'Vonage webhook rejected: invalid or replayed signed callback',
      );
      sendJson(ctx.res, 401, { error: 'Invalid signed callback.' });
      return null;
    }
    return parsed.body;
  }

  async function transferReply(session, text) {
    await transferVonageCallToNcco({
      applicationId: config.applicationId,
      privateKey: config.privateKey,
      callUuid: session.uuid,
      regionUrl: session.regionUrl,
      ncco: buildReplyNcco({
        text,
        language: config.language,
        interruptible: config.interruptible,
        inputEventUrl,
      }),
    });
  }

  async function runTurn(session, transcript) {
    try {
      const result = await api.dispatchInboundMessage({
        sessionId: buildVoiceSessionKey(agentId, session.uuid),
        sessionMode: 'resume',
        guildId: null,
        channelId: `voice:${session.uuid}`,
        userId: session.from || session.uuid,
        username: session.from || session.uuid,
        content: transcript,
        agentId,
      });
      const reply = String(result.result || '').trim();
      await transferReply(
        session,
        reply || 'I am sorry, I could not produce a response.',
      );
    } catch (error) {
      api.logger.error({ error, callUuid: session.uuid }, 'Vonage turn failed');
      await transferReply(
        session,
        'I am sorry, something went wrong. Please try again.',
      ).catch(() => {});
    } finally {
      session.busy = false;
    }
  }

  return {
    answerUrl: `${webhookBase}/answer`,
    eventUrl: `${webhookBase}/event`,

    async handleAnswer(ctx) {
      const body = await readSignedPayload(ctx);
      if (!body) return;
      const answer = parseVonageAnswerWebhook(body);
      if (!answer) {
        sendJson(ctx.res, 400, { error: 'Invalid answer payload.' });
        return;
      }
      if (
        !sessions.has(answer.uuid) &&
        sessions.size >= config.maxConcurrentCalls
      ) {
        sendJson(
          ctx.res,
          200,
          buildGoodbyeNcco({
            message: 'All assistants are busy. Please try again later.',
            language: config.language,
          }),
        );
        return;
      }
      sessions.set(answer.uuid, {
        ...answer,
        busy: false,
        silentTimeouts: 0,
      });
      sendJson(
        ctx.res,
        200,
        buildReplyNcco({
          text: config.welcomeGreeting,
          language: config.language,
          interruptible: config.interruptible,
          inputEventUrl,
        }),
      );
    },

    async handleInput(ctx) {
      const body = await readSignedPayload(ctx);
      if (!body) return;
      const input = parseVonageInputWebhook(body);
      if (!input) {
        sendJson(ctx.res, 400, { error: 'Invalid input payload.' });
        return;
      }
      const session = sessions.get(input.uuid);
      if (!session) {
        sendJson(ctx.res, 404, { error: 'Unknown call.' });
        return;
      }
      if (!input.transcript) {
        session.silentTimeouts += 1;
        sendJson(
          ctx.res,
          200,
          session.silentTimeouts >= MAX_SILENT_TIMEOUTS
            ? buildGoodbyeNcco({
                message: 'Goodbye.',
                language: config.language,
              })
            : buildReplyNcco({
                text: 'I did not hear anything. Please try again.',
                language: config.language,
                interruptible: config.interruptible,
                inputEventUrl,
              }),
        );
        return;
      }
      session.silentTimeouts = 0;
      sendJson(
        ctx.res,
        200,
        buildParkNcco({ language: config.language, inputEventUrl }),
      );
      if (!session.busy) {
        session.busy = true;
        void runTurn(session, input.transcript);
      }
    },

    async handleEvent(ctx) {
      const body = await readSignedPayload(ctx);
      if (!body) return;
      const event = parseVonageEventWebhook(body);
      if (event && VONAGE_TERMINAL_CALL_STATUSES.has(event.status)) {
        sessions.delete(event.uuid);
      }
      sendJson(ctx.res, 200, {});
    },

    stop() {
      sessions.clear();
      replayCache.clear();
    },
  };
}
