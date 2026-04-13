import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, * as wsModule from 'ws';
import { getConfigSnapshot, TWILIO_AUTH_TOKEN } from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types/container.js';
import { VOICE_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
import {
  type ConversationRelayInboundMessage,
  ConversationRelayResponseStream,
  type ConversationRelaySetupMessage,
  mergePromptFragment,
  parseConversationRelayMessage,
} from './conversation-relay.js';
import { ReplayProtector, validateTwilioSignature } from './security.js';
import { type VoiceCallSession, VoiceCallSessionStore } from './session.js';
import { formatTextForVoice } from './text.js';
import {
  buildPublicHttpUrl,
  buildPublicWsUrl,
  resolveVoiceWebhookPaths,
} from './twilio-manager.js';
import {
  buildConversationRelayTwiml,
  buildEmptyTwiml,
  buildHangupTwiml,
  readTwilioFormBody,
} from './webhook.js';

export type VoiceReplyFn = (content: string) => Promise<void>;

export interface VoiceMessageContext {
  abortSignal: AbortSignal;
  callSid: string;
  twilioSessionId: string;
  remoteIp: string;
  setupMessage: ConversationRelaySetupMessage | null;
  responseStream: ConversationRelayResponseStream;
}

export type VoiceMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: VoiceReplyFn,
  context: VoiceMessageContext,
) => Promise<void>;

const MAX_PENDING_UPGRADES = 32;
const MAX_CONNECTIONS_PER_IP = 16;
const REPLAY_TTL_MS = 30_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SHUTDOWN_POLL_MS = 100;
const MAX_RECONNECT_ATTEMPTS = 1;
const DUPLICATE_TWILIO_REQUEST_HEADER = 'i-twilio-idempotency-token';

const replayProtector = new ReplayProtector(REPLAY_TTL_MS);
let runtimeInitialized = false;
let draining = false;
let voiceMessageHandler: VoiceMessageHandler | null = null;
const sessionStore = new VoiceCallSessionStore(
  getConfigSnapshot().voice.maxConcurrentCalls,
  MAX_PENDING_UPGRADES,
  MAX_CONNECTIONS_PER_IP,
);
type WebSocketServerLike = {
  on: (
    event: 'connection',
    listener: (socket: WebSocket, req: IncomingMessage) => void,
  ) => void;
  emit: (
    event: 'connection',
    socket: WebSocket,
    req: IncomingMessage,
  ) => boolean;
  handleUpgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (socket: WebSocket) => void,
  ) => void;
  removeAllListeners: () => void;
};
const WebSocketServerCtor = (
  wsModule as unknown as {
    WebSocketServer: new (options: { noServer: true }) => WebSocketServerLike;
  }
).WebSocketServer;
let websocketServer = new WebSocketServerCtor({ noServer: true });

function sendXml(res: ServerResponse, statusCode: number, body: string): void {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/xml; charset=utf-8');
  res.end(body);
}

function writeUpgradeError(
  socket: Duplex,
  statusCode: number,
  message: string,
): void {
  const reason = String(message || 'Error');
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(reason)}\r\n\r\n` +
      reason,
  );
  socket.destroy();
}

function resolveRemoteIp(req: IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor;
  const candidate = String(forwarded || '')
    .split(',')[0]
    .trim();
  return candidate || String(req.socket.remoteAddress || 'unknown').trim();
}

function resolveTwilioAuthToken(): string {
  return String(TWILIO_AUTH_TOKEN || '').trim();
}

function decodeCloseReason(reason: Buffer | string): string {
  const decoded = Buffer.isBuffer(reason)
    ? reason.toString('utf8').trim()
    : String(reason || '').trim();
  return decoded || '<empty>';
}

function isVoiceRelayDisconnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Voice websocket is not connected.'
  );
}

function observeReplay(req: IncomingMessage): void {
  const raw = req.headers[DUPLICATE_TWILIO_REQUEST_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!replayProtector.observe(token)) {
    logger.warn(
      { replayToken: token },
      'Duplicate Twilio voice request observed',
    );
  }
}

function validateHttpWebhookSignature(
  req: IncomingMessage,
  url: URL,
  values: Record<string, string>,
): boolean {
  const signature = Array.isArray(req.headers['x-twilio-signature'])
    ? req.headers['x-twilio-signature'][0]
    : req.headers['x-twilio-signature'];
  const authToken = resolveTwilioAuthToken();
  const fullUrl = buildPublicHttpUrl(req, `${url.pathname}${url.search}`);
  return validateTwilioSignature({
    authToken,
    signature,
    url: fullUrl,
    values,
  });
}

function validateUpgradeSignature(req: IncomingMessage, url: URL): boolean {
  const signature = Array.isArray(req.headers['x-twilio-signature'])
    ? req.headers['x-twilio-signature'][0]
    : req.headers['x-twilio-signature'];
  const authToken = resolveTwilioAuthToken();
  const fullUrl = buildPublicWsUrl(req, `${url.pathname}${url.search}`);
  return validateTwilioSignature({
    authToken,
    signature,
    url: fullUrl,
  });
}

function transitionSession(
  callSid: string,
  next: Parameters<VoiceCallSessionStore['transition']>[1],
): void {
  try {
    const previous = sessionStore.get(callSid)?.state;
    sessionStore.transition(callSid, next);
    logger.debug({ callSid, previous, next }, 'Voice session state changed');
  } catch (error) {
    logger.debug(
      { error, callSid, next },
      'Voice session state transition skipped',
    );
  }
}

async function sendWsPayload(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(payload), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sendBusyTwiml(res: ServerResponse): Promise<void> {
  sendXml(
    res,
    200,
    buildHangupTwiml(
      'HybridClaw voice is at capacity right now. Please try again shortly.',
    ),
  );
}

function isReconnectableFailure(params: Record<string, string>): boolean {
  const sessionStatus = String(params.SessionStatus || '')
    .trim()
    .toLowerCase();
  const callStatus = String(params.CallStatus || '')
    .trim()
    .toLowerCase();
  const errorMessage = String(params.ErrorMessage || '')
    .trim()
    .toLowerCase();
  return (
    sessionStatus === 'failed' &&
    callStatus === 'in-progress' &&
    errorMessage.includes('websocket')
  );
}

function buildRelayTwimlForRequest(
  req: IncomingMessage,
  callSid: string,
): string {
  const voiceConfig = getConfigSnapshot().voice;
  const paths = resolveVoiceWebhookPaths(voiceConfig.webhookPath);
  return buildConversationRelayTwiml({
    websocketUrl: buildPublicWsUrl(req, paths.relayPath),
    actionUrl: buildPublicHttpUrl(req, paths.actionPath),
    relay: voiceConfig.relay,
    customParameters: {
      callReference: callSid,
    },
  });
}

async function dispatchPromptToHandler(
  session: VoiceCallSession,
  content: string,
  language: string,
): Promise<void> {
  const handler = voiceMessageHandler;
  if (!handler || !session.ws) {
    return;
  }

  session.controller?.abort();
  const controller = new AbortController();
  sessionStore.setController(session.callSid, controller);
  transitionSession(session.callSid, 'thinking');

  const responseStream = new ConversationRelayResponseStream(
    async (payload) => {
      if (controller.signal.aborted) {
        return;
      }
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
        throw new Error('Voice websocket is not connected.');
      }
      await sendWsPayload(session.ws, payload);
    },
    {
      interruptible: getConfigSnapshot().voice.relay.interruptible,
      language,
      onFirstToken: () => {
        transitionSession(session.callSid, 'speaking');
      },
      onFinished: () => {
        if (!controller.signal.aborted) {
          transitionSession(session.callSid, 'listening');
        }
      },
    },
  );

  const reply: VoiceReplyFn = async (text) => {
    await responseStream.reply(formatTextForVoice(text), { language });
  };

  try {
    await handler(
      session.gatewaySessionId,
      null,
      session.channelId,
      session.userId,
      session.username,
      content,
      [],
      reply,
      {
        abortSignal: controller.signal,
        callSid: session.callSid,
        twilioSessionId: session.twilioSessionId || '',
        remoteIp: session.remoteIp,
        setupMessage: session.setupMessage,
        responseStream,
      },
    );
    if (!controller.signal.aborted && !responseStream.finished) {
      if (responseStream.hasEmittedText) {
        await responseStream.finish({ language });
      } else {
        await responseStream.reply('I do not have a spoken response yet.', {
          language,
        });
      }
    }
  } catch (error) {
    if (controller.signal.aborted || isVoiceRelayDisconnectedError(error)) {
      logger.debug(
        { callSid: session.callSid, channelId: session.channelId },
        'Voice prompt handling aborted after relay disconnect',
      );
      return;
    }
    logger.warn(
      { error, callSid: session.callSid, channelId: session.channelId },
      'Voice prompt handling failed',
    );
    if (!responseStream.finished) {
      try {
        await responseStream.reply(
          'Sorry, something went wrong while I was answering that.',
          { language },
        );
      } catch (replyError) {
        if (
          !controller.signal.aborted &&
          !isVoiceRelayDisconnectedError(replyError)
        ) {
          throw replyError;
        }
      }
    }
  } finally {
    sessionStore.setController(session.callSid, null);
  }
}

async function handleRelayMessage(
  session: VoiceCallSession,
  message: ConversationRelayInboundMessage,
): Promise<void> {
  if (message.type === 'prompt') {
    logger.debug(
      {
        callSid: session.callSid,
        language: message.lang || getConfigSnapshot().voice.relay.language,
        last: message.last,
        promptLength: message.voicePrompt.length,
      },
      'Voice relay prompt fragment received',
    );
    const merged = mergePromptFragment(
      session.promptBuffer,
      message.voicePrompt,
    );
    sessionStore.bufferPrompt(session.callSid, merged);
    if (!message.last) {
      transitionSession(session.callSid, 'listening');
      return;
    }
    sessionStore.clearPrompt(session.callSid);
    await dispatchPromptToHandler(
      session,
      merged,
      message.lang || getConfigSnapshot().voice.relay.language,
    );
    return;
  }
  if (message.type === 'dtmf') {
    logger.info(
      { callSid: session.callSid, digit: message.digit },
      'Voice relay DTMF received',
    );
    await dispatchPromptToHandler(
      session,
      `The caller pressed the keypad digit "${message.digit}".`,
      getConfigSnapshot().voice.relay.language,
    );
    return;
  }
  if (message.type === 'interrupt') {
    logger.info(
      {
        callSid: session.callSid,
        utteranceUntilInterrupt: message.utteranceUntilInterrupt || '',
        durationUntilInterruptMs: message.durationUntilInterruptMs,
      },
      'Voice relay interrupted',
    );
    session.controller?.abort();
    transitionSession(session.callSid, 'interrupted');
    return;
  }
  if (message.type === 'error') {
    logger.warn(
      { description: message.description, callSid: session.callSid },
      'ConversationRelay reported an error',
    );
    transitionSession(session.callSid, 'failed');
  }
}

function handleWebSocketConnection(ws: WebSocket, remoteIp: string): void {
  let callSid: string | null = null;
  let setupReceived = false;

  ws.on('message', (raw) => {
    void (async () => {
      try {
        const message = parseConversationRelayMessage(raw);
        if (message.type === 'setup') {
          const session = sessionStore.attachSetup({
            setup: message,
            remoteIp,
            ws,
          });
          if (!session) {
            await sendWsPayload(ws, {
              type: 'end',
              handoffData: JSON.stringify({ reason: 'capacity-exceeded' }),
            });
            ws.close();
            return;
          }
          callSid = message.callSid;
          setupReceived = true;
          logger.info(
            {
              callSid: message.callSid,
              twilioSessionId: message.sessionId,
              remoteIp,
              direction: message.direction || '',
              from: message.from,
              to: message.to,
            },
            'Voice relay setup received',
          );
          transitionSession(callSid, 'relay-connecting');
          transitionSession(callSid, 'setup-received');
          transitionSession(callSid, 'listening');
          return;
        }
        if (!setupReceived || !callSid) {
          throw new Error('ConversationRelay prompt arrived before setup.');
        }
        const session = sessionStore.get(callSid);
        if (!session) {
          throw new Error(`Unknown voice session for call ${callSid}`);
        }
        await handleRelayMessage(session, message);
      } catch (error) {
        logger.warn({ error, callSid, remoteIp }, 'Voice relay message failed');
        if (callSid) {
          transitionSession(callSid, 'failed');
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1008, 'Invalid voice relay message');
        }
      }
    })();
  });

  ws.on('close', (code, reason) => {
    logger.info(
      {
        callSid,
        remoteIp,
        code,
        reason: decodeCloseReason(reason),
        setupReceived,
      },
      'Voice relay websocket closed',
    );
    if (!callSid) {
      return;
    }
    const session = sessionStore.get(callSid);
    if (!session) {
      return;
    }
    session.controller?.abort();
    session.ws = null;
    sessionStore.setController(callSid, null);
    if (!draining && session.state !== 'ended' && session.state !== 'failed') {
      transitionSession(callSid, 'reconnecting');
    }
  });

  ws.on('error', (error) => {
    logger.debug({ error, callSid, remoteIp }, 'Voice relay websocket error');
  });
}

export async function initVoice(
  messageHandler: VoiceMessageHandler,
): Promise<void> {
  voiceMessageHandler = messageHandler;
  draining = false;
  sessionStore.updateLimits(getConfigSnapshot().voice.maxConcurrentCalls);
  if (runtimeInitialized) {
    return;
  }
  runtimeInitialized = true;
  websocketServer.removeAllListeners();
  websocketServer = new WebSocketServerCtor({ noServer: true });
  registerChannel({
    kind: 'voice',
    id: 'voice',
    capabilities: VOICE_CAPABILITIES,
  });
  websocketServer.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    handleWebSocketConnection(ws, resolveRemoteIp(req));
  });
}

export async function handleVoiceWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const paths = resolveVoiceWebhookPaths(getConfigSnapshot().voice.webhookPath);
  if (req.method !== 'POST') {
    return false;
  }

  if (url.pathname === paths.webhookPath) {
    const body = await readTwilioFormBody(req);
    if (!validateHttpWebhookSignature(req, url, body)) {
      logger.warn(
        {
          remoteIp: resolveRemoteIp(req),
          path: url.pathname,
          hasSignature: Boolean(req.headers['x-twilio-signature']),
        },
        'Voice webhook rejected: invalid Twilio signature',
      );
      sendXml(res, 403, buildEmptyTwiml());
      return true;
    }
    observeReplay(req);
    if (draining) {
      await sendBusyTwiml(res);
      return true;
    }

    const callSid = String(body.CallSid || '').trim();
    if (!callSid) {
      logger.warn(
        { remoteIp: resolveRemoteIp(req), path: url.pathname },
        'Voice webhook rejected: missing CallSid',
      );
      sendXml(res, 400, buildEmptyTwiml());
      return true;
    }
    const session = sessionStore.getOrCreateFromWebhook({
      callSid,
      remoteIp: resolveRemoteIp(req),
      from: String(body.From || '').trim(),
      to: String(body.To || '').trim(),
      callerName: String(body.CallerName || '').trim() || undefined,
    });
    if (!session) {
      await sendBusyTwiml(res);
      return true;
    }
    transitionSession(callSid, 'twiml-issued');
    logger.info(
      {
        callSid,
        remoteIp: resolveRemoteIp(req),
        from: String(body.From || '').trim(),
        to: String(body.To || '').trim(),
      },
      'Voice webhook accepted',
    );
    sendXml(res, 200, buildRelayTwimlForRequest(req, callSid));
    return true;
  }

  if (url.pathname === paths.actionPath) {
    const body = await readTwilioFormBody(req);
    if (!validateHttpWebhookSignature(req, url, body)) {
      logger.warn(
        {
          remoteIp: resolveRemoteIp(req),
          path: url.pathname,
          hasSignature: Boolean(req.headers['x-twilio-signature']),
        },
        'Voice action callback rejected: invalid Twilio signature',
      );
      sendXml(res, 403, buildEmptyTwiml());
      return true;
    }
    observeReplay(req);

    const callSid = String(body.CallSid || '').trim();
    const session = callSid ? sessionStore.get(callSid) : undefined;
    if (callSid) {
      sessionStore.markActionCallback(callSid);
    }
    logger.info(
      {
        callSid,
        remoteIp: resolveRemoteIp(req),
        twilioSessionId: String(body.SessionId || '').trim(),
        sessionStatus: String(body.SessionStatus || '').trim(),
        callStatus: String(body.CallStatus || '').trim(),
        sessionDuration: String(body.SessionDuration || '').trim(),
        errorMessage: String(body.ErrorMessage || '').trim(),
      },
      'Voice action callback received',
    );

    if (
      session &&
      !draining &&
      session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
      isReconnectableFailure(body)
    ) {
      sessionStore.markReconnectAttempt(callSid);
      transitionSession(callSid, 'relay-connecting');
      sendXml(res, 200, buildRelayTwimlForRequest(req, callSid));
      return true;
    }

    if (callSid) {
      const sessionStatus = String(body.SessionStatus || '')
        .trim()
        .toLowerCase();
      transitionSession(
        callSid,
        sessionStatus === 'ended' ? 'ended' : 'failed',
      );
      sessionStore.remove(callSid);
    }
    sendXml(res, 200, buildEmptyTwiml());
    return true;
  }

  return false;
}

export function handleVoiceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
): boolean {
  const paths = resolveVoiceWebhookPaths(getConfigSnapshot().voice.webhookPath);
  if (url.pathname !== paths.relayPath) {
    return false;
  }
  if (draining || !runtimeInitialized) {
    logger.warn(
      { remoteIp: resolveRemoteIp(req), path: url.pathname },
      'Voice relay rejected: runtime unavailable',
    );
    writeUpgradeError(socket, 503, 'Voice channel unavailable');
    return true;
  }
  if (!validateUpgradeSignature(req, url)) {
    logger.warn(
      {
        remoteIp: resolveRemoteIp(req),
        path: url.pathname,
        hasSignature: Boolean(req.headers['x-twilio-signature']),
      },
      'Voice relay rejected: invalid Twilio signature',
    );
    writeUpgradeError(socket, 403, 'Forbidden');
    return true;
  }
  const remoteIp = resolveRemoteIp(req);
  if (!sessionStore.beginPendingConnection(remoteIp)) {
    logger.warn(
      { remoteIp, path: url.pathname },
      'Voice relay rejected: too many pending connections',
    );
    writeUpgradeError(socket, 429, 'Too Many Connections');
    return true;
  }
  logger.info(
    { remoteIp, path: url.pathname },
    'Voice relay websocket upgrade accepted',
  );
  websocketServer.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    sessionStore.endPendingConnection(remoteIp);
    websocketServer.emit('connection', ws, req);
  });
  return true;
}

export async function shutdownVoice(opts?: { drain?: boolean }): Promise<void> {
  draining = true;
  if (opts?.drain) {
    const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
    while (sessionStore.activeCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
    }
  }

  await Promise.all(
    sessionStore.list().map(async (session) => {
      session.controller?.abort();
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        try {
          await sendWsPayload(session.ws, {
            type: 'end',
            handoffData: JSON.stringify({ reason: 'gateway-shutdown' }),
          });
        } catch (error) {
          logger.debug(
            { error, callSid: session.callSid },
            'Voice shutdown end failed',
          );
        }
        session.ws.close();
      }
      sessionStore.remove(session.callSid);
    }),
  );
  runtimeInitialized = false;
  voiceMessageHandler = null;
  websocketServer.removeAllListeners();
  websocketServer = new WebSocketServerCtor({ noServer: true });
}
