/**
 * Twilio webhook and websocket entry points, and the live call table.
 *
 * Every request is authenticated before it touches state: HTTP webhooks and
 * websocket upgrades must carry a valid X-Twilio-Signature for the public URL
 * Twilio called, and webhook replays inside 30 s are refused. Settings are
 * read live from the core `voice.*` config on each request, so console edits
 * apply to the next call. Signed action callbacks are accepted even while
 * stopping so Twilio can finish terminal cleanup.
 */
import {
  findNationalFormatAllowEntries,
  isCallerAllowed,
  normalizeCallerIdentity,
} from './caller-policy.js';
import { createRealtimeCalls } from './realtime.js';
import { createRelayCalls } from './relay.js';
import { createReplayProtector, validateTwilioSignature } from './security.js';
import { createSessionStore } from './session-store.js';
import {
  buildConversationRelayTwiml,
  buildEmptyTwiml,
  buildHangupTwiml,
  buildMediaStreamTwiml,
  readTwilioFormBody,
} from './twiml.js';
import {
  resolveBaseUrl,
  resolveRemoteIp,
  TWILIO_VOICE_PATHS,
  toWebsocketUrl,
} from './urls.js';

const REPLAY_TTL_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 1;
const DUPLICATE_REQUEST_HEADER = 'i-twilio-idempotency-token';
const UNAVAILABLE_MESSAGE =
  'HybridClaw voice is unavailable right now. Please try again shortly.';
const BUSY_MESSAGE =
  'HybridClaw voice is at capacity right now. Please try again shortly.';
const CALLER_REFUSED_MESSAGE =
  'Sorry, this number is not available for your call. Goodbye.';

function readHeader(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendXml(res, statusCode, body) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/xml; charset=utf-8');
  res.end(body);
}

function isReconnectableFailure(body) {
  const sessionStatus = String(body.SessionStatus || '')
    .trim()
    .toLowerCase();
  const callStatus = String(body.CallStatus || '')
    .trim()
    .toLowerCase();
  const errorMessage = String(body.ErrorMessage || '')
    .trim()
    .toLowerCase();
  return (
    sessionStatus === 'failed' &&
    callStatus === 'in-progress' &&
    errorMessage.includes('websocket')
  );
}

export function createTwilioVoiceRuntime(api) {
  const logger = api.logger;
  const sessions = createSessionStore({
    resolveAgentId: () => api.getDefaultAgentId(),
  });
  const replay = createReplayProtector(REPLAY_TTL_MS);
  let stopping = false;
  let missingTokenLogged = false;

  function transition(callSid, next) {
    try {
      const previous = sessions.get(callSid)?.state;
      sessions.transition(callSid, next);
      logger.debug({ callSid, previous, next }, 'Twilio call state changed');
    } catch (error) {
      logger.debug(
        { error, callSid, next },
        'Twilio call state change skipped',
      );
    }
  }

  const relay = createRelayCalls({ api, sessions, transition });
  const realtime = createRealtimeCalls({ api, sessions, transition });

  function resolveAuthToken() {
    const token =
      api.getCredential('TWILIO_AUTH_TOKEN') ||
      String(api.getVoiceConfig().twilio.authToken || '').trim();
    if (!token && !missingTokenLogged) {
      missingTokenLogged = true;
      logger.warn(
        'Twilio voice has no TWILIO_AUTH_TOKEN; rejecting signed requests until one is stored.',
      );
    }
    if (token) missingTokenLogged = false;
    return token;
  }

  /** Why calls cannot be answered right now, or null when they can. */
  function unavailableReason(settings) {
    if (!settings.enabled) return 'voice.enabled is off';
    if (stopping) return 'plugin is stopping';
    if (
      !settings.twilio.accountSid.trim() ||
      !settings.twilio.fromNumber.trim()
    ) {
      return 'voice.twilio.accountSid or voice.twilio.fromNumber is unset';
    }
    if (settings.mode === 'realtime' && !api.isRealtimeVoiceAvailable()) {
      return 'realtime voice has no credential';
    }
    return null;
  }

  function signedUrl(req, url, { websocket }) {
    const httpUrl = `${resolveBaseUrl(api, req)}${url.pathname}${url.search}`;
    return websocket ? toWebsocketUrl(httpUrl) : httpUrl;
  }

  async function readSignedWebhook(ctx, remoteIp) {
    const body = await readTwilioFormBody(ctx.req);
    if (!body) {
      sendXml(ctx.res, 413, buildEmptyTwiml());
      return null;
    }
    const valid = validateTwilioSignature({
      authToken: resolveAuthToken(),
      signature: readHeader(ctx.req, 'x-twilio-signature'),
      url: signedUrl(ctx.req, ctx.url, { websocket: false }),
      values: body,
    });
    if (!valid) {
      logger.warn(
        {
          remoteIp,
          webhook: ctx.webhookName,
          hasSignature: Boolean(readHeader(ctx.req, 'x-twilio-signature')),
        },
        'Twilio webhook rejected: invalid signature',
      );
      sendXml(ctx.res, 403, buildEmptyTwiml());
      return null;
    }
    if (!replay.observe(readHeader(ctx.req, DUPLICATE_REQUEST_HEADER))) {
      logger.warn(
        { remoteIp, webhook: ctx.webhookName },
        'Twilio webhook rejected: duplicate request',
      );
      sendXml(
        ctx.res,
        409,
        buildHangupTwiml('Duplicate Twilio voice request ignored.'),
      );
      return null;
    }
    return body;
  }

  function buildCallTwiml(req, callSid, settings) {
    const baseUrl = resolveBaseUrl(api, req);
    const actionUrl = `${baseUrl}${TWILIO_VOICE_PATHS.action}`;
    const customParameters = { callReference: callSid };
    if (settings.mode === 'realtime') {
      return buildMediaStreamTwiml({
        websocketUrl: toWebsocketUrl(`${baseUrl}${TWILIO_VOICE_PATHS.stream}`),
        actionUrl,
        customParameters,
      });
    }
    return buildConversationRelayTwiml({
      websocketUrl: toWebsocketUrl(`${baseUrl}${TWILIO_VOICE_PATHS.relay}`),
      actionUrl,
      relay: settings.relay,
      customParameters,
    });
  }

  async function handleIncomingCall(ctx) {
    const remoteIp = resolveRemoteIp(ctx.req);
    const body = await readSignedWebhook(ctx, remoteIp);
    if (!body) return;
    const settings = api.getVoiceConfig();
    const reason = unavailableReason(settings);
    if (reason) {
      logger.warn(
        { remoteIp, reason },
        'Twilio call refused: voice unavailable',
      );
      sendXml(ctx.res, 200, buildHangupTwiml(UNAVAILABLE_MESSAGE));
      return;
    }
    const callSid = String(body.CallSid || '').trim();
    if (!callSid) {
      logger.warn({ remoteIp }, 'Twilio call refused: missing CallSid');
      sendXml(ctx.res, 400, buildEmptyTwiml());
      return;
    }
    const from = String(body.From || '').trim();
    if (
      !isCallerAllowed({
        callerPolicy: settings.callerPolicy,
        allowFrom: settings.allowFrom,
        from,
      })
    ) {
      // The refused number is logged so an operator can add a legitimate
      // caller to allowFrom; without it the allowlist is undiagnosable.
      logger.warn(
        {
          callSid,
          remoteIp,
          callerPolicy: settings.callerPolicy,
          caller: normalizeCallerIdentity(from) || 'withheld',
        },
        'Twilio call refused: caller not permitted by callerPolicy',
      );
      sendXml(ctx.res, 200, buildHangupTwiml(CALLER_REFUSED_MESSAGE));
      return;
    }
    const to = String(body.To || '').trim();
    const session = sessions.getOrCreate(
      {
        callSid,
        remoteIp,
        from,
        to,
        callerName: String(body.CallerName || '').trim() || undefined,
      },
      settings.maxConcurrentCalls,
    );
    if (!session) {
      sendXml(ctx.res, 200, buildHangupTwiml(BUSY_MESSAGE));
      return;
    }
    transition(callSid, 'twiml-issued');
    logger.info(
      { callSid, remoteIp, from, to, mode: settings.mode },
      'Twilio call accepted',
    );
    sendXml(ctx.res, 200, buildCallTwiml(ctx.req, callSid, settings));
  }

  async function handleAction(ctx) {
    const remoteIp = resolveRemoteIp(ctx.req);
    const body = await readSignedWebhook(ctx, remoteIp);
    if (!body) return;
    const callSid = String(body.CallSid || '').trim();
    const session = callSid ? sessions.get(callSid) : undefined;
    logger.info(
      {
        callSid,
        remoteIp,
        sessionStatus: String(body.SessionStatus || '').trim(),
        callStatus: String(body.CallStatus || '').trim(),
        errorMessage: String(body.ErrorMessage || '').trim(),
      },
      'Twilio action callback received',
    );
    if (
      session &&
      !stopping &&
      session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
      isReconnectableFailure(body)
    ) {
      session.reconnectAttempts += 1;
      transition(callSid, 'relay-connecting');
      sendXml(
        ctx.res,
        200,
        buildCallTwiml(ctx.req, callSid, api.getVoiceConfig()),
      );
      return;
    }
    if (session) {
      const ended =
        String(body.SessionStatus || '')
          .trim()
          .toLowerCase() === 'ended';
      if (session.realtime) {
        realtime.teardown(callSid, ended ? 'ended' : 'failed');
      } else {
        transition(callSid, ended ? 'ended' : 'failed');
        sessions.remove(callSid);
      }
    }
    sendXml(ctx.res, 200, buildEmptyTwiml());
  }

  async function acceptSignedUpgrade(ctx, mode) {
    const remoteIp = resolveRemoteIp(ctx.req);
    const settings = api.getVoiceConfig();
    if (settings.mode !== mode) {
      ctx.reject(404, 'Not Found');
      return null;
    }
    const reason = unavailableReason(settings);
    if (reason) {
      logger.warn(
        { remoteIp, reason },
        'Twilio websocket refused: voice unavailable',
      );
      ctx.reject(503, 'Voice channel unavailable');
      return null;
    }
    const valid = validateTwilioSignature({
      authToken: resolveAuthToken(),
      signature: readHeader(ctx.req, 'x-twilio-signature'),
      url: signedUrl(ctx.req, ctx.url, { websocket: true }),
    });
    if (!valid) {
      logger.warn(
        {
          remoteIp,
          webhook: ctx.webhookName,
          hasSignature: Boolean(readHeader(ctx.req, 'x-twilio-signature')),
        },
        'Twilio websocket rejected: invalid signature',
      );
      ctx.reject(403, 'Forbidden');
      return null;
    }
    return { ws: await ctx.accept(), remoteIp };
  }

  return {
    handleIncomingCall,
    handleAction,

    async handleRelayUpgrade(ctx) {
      const accepted = await acceptSignedUpgrade(ctx, 'relay');
      if (!accepted) return;
      relay.handleConnection(accepted.ws, accepted.remoteIp, {
        isStopping: () => stopping,
      });
    },

    async handleStreamUpgrade(ctx) {
      const accepted = await acceptSignedUpgrade(ctx, 'realtime');
      if (!accepted) return;
      realtime.handleConnection(accepted.ws, accepted.remoteIp);
    },

    resolveAuthToken,

    logReady() {
      const settings = api.getVoiceConfig();
      const nationalFormat =
        settings.callerPolicy === 'allowlist'
          ? findNationalFormatAllowEntries(settings.allowFrom)
          : [];
      if (nationalFormat.length > 0) {
        logger.warn(
          { entries: nationalFormat },
          'Voice allowlist entries are missing a country code and will never match; use E.164 (+4915123456789, not 015123456789)',
        );
      }
      logger.info(
        {
          enabled: settings.enabled,
          mode: settings.mode,
          callerPolicy: settings.callerPolicy,
          webhookPath: TWILIO_VOICE_PATHS.webhook,
          unavailableReason: unavailableReason(settings),
        },
        'Twilio voice plugin ready',
      );
    },

    async stop() {
      stopping = true;
      await Promise.all(
        sessions.list().map(async (session) => {
          session.controller?.abort();
          if (session.realtime) {
            // Media streams carry raw audio; a ConversationRelay `end` frame
            // would be an unknown event to Twilio there.
            session.ws?.close();
            realtime.teardown(session.callSid, 'ended');
            return;
          }
          await relay.endCall(session);
          sessions.remove(session.callSid);
        }),
      );
      replay.clear();
    },
  };
}
