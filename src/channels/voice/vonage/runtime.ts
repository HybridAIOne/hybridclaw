/**
 * Vonage voice runtime — signed-webhook turn loop for phone calls.
 *
 * Vonage has no Twilio ConversationRelay equivalent, so this runtime is
 * strictly turn-based: every webhook response returns quickly (Vonage cuts
 * slow webhooks off after seconds), agent turns run detached, and finished
 * replies reach the live call via REST NCCO transfer — never via the webhook
 * response. Every inbound request must carry a valid signed-callback JWT;
 * unsigned traffic is rejected.
 *
 * NOT the Twilio websocket relay (../runtime.ts) — no websocket exists here,
 * and the two runtimes share only the session store and handler contract.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getConfigSnapshot,
  VONAGE_PRIVATE_KEY,
  VONAGE_SIGNATURE_SECRET,
} from '../../../config/config.js';
import { logger } from '../../../logger.js';
import type { VoiceMessageHandler, VoiceReplyFn } from '../runtime.js';
import { ReplayProtector } from '../security.js';
import { type VoiceCallSession, VoiceCallSessionStore } from '../session.js';
import { formatTextForVoice } from '../text.js';
import type { VoiceResponseStream } from '../types.js';
import {
  buildPublicHttpUrl,
  resolveVoiceWebhookPaths,
} from '../webhook-paths.js';
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
  type VonageNccoAction,
} from './ncco.js';

const MAX_BODY_BYTES = 256 * 1024;
const PREINIT_MAX_CONCURRENT_CALLS = 1;
// 3 (owner call, 2026-08-06): consecutive silent input timeouts before the
// call is ended; keeps an abandoned handset from staying connected (and
// billed) indefinitely.
const MAX_SILENT_TIMEOUTS = 3;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SHUTDOWN_POLL_MS = 100;

const replayProtector = new ReplayProtector(WEBHOOK_JWT_MAX_AGE_SECONDS * 1000);
const sessionStore = new VoiceCallSessionStore(
  PREINIT_MAX_CONCURRENT_CALLS,
  0,
  0,
);
interface VonageCallState {
  regionUrl: string;
  silentTimeouts: number;
}
const callStates = new Map<string, VonageCallState>();
let voiceMessageHandler: VoiceMessageHandler | null = null;
let draining = false;
let runtimeInitialized = false;

function isVonageRuntimeAvailable(): boolean {
  return runtimeInitialized && !draining && voiceMessageHandler !== null;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
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

async function readRawBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validateSignedWebhook(params: {
  req: IncomingMessage;
  rawBody: string;
  remoteIp: string;
  path: string;
}): boolean {
  const signatureSecret = String(VONAGE_SIGNATURE_SECRET || '').trim();
  const token = extractBearerToken(params.req.headers.authorization);
  const claims = signatureSecret
    ? verifyVonageWebhookJwt({
        token,
        signatureSecret,
        rawBody: params.rawBody,
      })
    : null;
  if (!claims) {
    logger.warn(
      {
        remoteIp: params.remoteIp,
        path: params.path,
        hasAuthorization: Boolean(token),
        signatureSecretConfigured: Boolean(signatureSecret),
      },
      'Vonage voice webhook rejected: invalid signed-callback JWT',
    );
    return false;
  }
  if (claims.jti && !replayProtector.observe(claims.jti)) {
    logger.warn(
      { remoteIp: params.remoteIp, path: params.path },
      'Vonage voice webhook rejected: replayed signed-callback JWT',
    );
    return false;
  }
  return true;
}

function transitionSession(
  callUuid: string,
  next: Parameters<VoiceCallSessionStore['transition']>[1],
): void {
  try {
    const previous = sessionStore.get(callUuid)?.state;
    sessionStore.transition(callUuid, next);
    logger.debug(
      { callUuid, previous, next },
      'Vonage voice session state changed',
    );
  } catch (error) {
    logger.debug(
      { error, callUuid, next },
      'Vonage voice session state transition skipped',
    );
  }
}

function getCallState(callUuid: string): VonageCallState {
  let state = callStates.get(callUuid);
  if (!state) {
    state = { regionUrl: '', silentTimeouts: 0 };
    callStates.set(callUuid, state);
  }
  return state;
}

function removeSession(callUuid: string): void {
  const session = sessionStore.get(callUuid);
  session?.controller?.abort();
  sessionStore.remove(callUuid);
  callStates.delete(callUuid);
}

function resolveInputEventUrl(req: IncomingMessage): string {
  const paths = resolveVoiceWebhookPaths(getConfigSnapshot().voice.webhookPath);
  return buildPublicHttpUrl(req, paths.inputPath);
}

class VonageTurnCollector implements VoiceResponseStream {
  private readonly parts: string[] = [];
  private closed = false;

  constructor(private readonly onFinished: (text: string) => Promise<void>) {}

  get finished(): boolean {
    return this.closed;
  }

  get hasEmittedText(): boolean {
    return this.parts.some((part) => part.trim().length > 0);
  }

  async push(token: string): Promise<void> {
    if (this.closed) return;
    const normalized = String(token || '');
    if (normalized) this.parts.push(normalized);
  }

  async reply(text: string): Promise<void> {
    if (this.closed) return;
    const normalized = String(text || '');
    if (normalized) this.parts.push(normalized);
    await this.finish();
  }

  async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.onFinished(this.parts.join(''));
  }
}

async function transferReply(
  session: VoiceCallSession,
  text: string,
  inputEventUrl: string,
): Promise<void> {
  const voiceConfig = getConfigSnapshot().voice;
  const ncco = buildReplyNcco({
    text,
    language: voiceConfig.relay.language,
    interruptible: voiceConfig.relay.interruptible,
    inputEventUrl,
  });
  await transferVonageCallToNcco({
    applicationId: voiceConfig.vonage.applicationId,
    privateKey: VONAGE_PRIVATE_KEY,
    callUuid: session.callSid,
    ncco,
    regionUrl: getCallState(session.callSid).regionUrl,
  });
}

async function dispatchTranscript(
  session: VoiceCallSession,
  content: string,
  inputEventUrl: string,
): Promise<void> {
  const handler = voiceMessageHandler;
  if (!handler) return;

  session.controller?.abort();
  const controller = new AbortController();
  sessionStore.setController(session.callSid, controller);
  transitionSession(session.callSid, 'thinking');

  const collector = new VonageTurnCollector(async (text) => {
    if (controller.signal.aborted) return;
    const spoken = text.trim() || 'I do not have a spoken response yet.';
    transitionSession(session.callSid, 'speaking');
    await transferReply(session, spoken, inputEventUrl);
    if (!controller.signal.aborted) {
      transitionSession(session.callSid, 'listening');
    }
  });

  const reply: VoiceReplyFn = async (text) => {
    await collector.reply(formatTextForVoice(text));
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
        providerSessionId: session.providerSessionId || '',
        remoteIp: session.remoteIp,
        setupMessage: null,
        responseStream: collector,
      },
    );
    if (!controller.signal.aborted && !collector.finished) {
      await collector.finish();
    }
  } catch (error) {
    if (controller.signal.aborted) {
      logger.debug(
        { callUuid: session.callSid, channelId: session.channelId },
        'Vonage voice turn aborted',
      );
      return;
    }
    logger.warn(
      { error, callUuid: session.callSid, channelId: session.channelId },
      'Vonage voice turn failed',
    );
    if (!collector.finished) {
      try {
        await collector.reply(
          'Sorry, something went wrong while I was answering that.',
        );
      } catch (replyError) {
        logger.warn(
          { error: replyError, callUuid: session.callSid },
          'Vonage voice error reply failed',
        );
      }
    }
  } finally {
    if (session.controller === controller) {
      sessionStore.setController(session.callSid, null);
    }
  }
}

function busyNcco(language: string): VonageNccoAction[] {
  return buildGoodbyeNcco({
    message:
      'HybridClaw voice is at capacity right now. Please try again shortly.',
    language,
  });
}

function unavailableNcco(language: string): VonageNccoAction[] {
  return buildGoodbyeNcco({
    message:
      'HybridClaw voice is unavailable right now. Please try again shortly.',
    language,
  });
}

async function handleAnswerWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  remoteIp: string,
): Promise<void> {
  const voiceConfig = getConfigSnapshot().voice;
  const language = voiceConfig.relay.language;
  const rawBody = req.method === 'POST' ? await readRawBody(req) : '';
  if (rawBody === null) {
    sendJson(res, 413, []);
    return;
  }
  if (!validateSignedWebhook({ req, rawBody, remoteIp, path: url.pathname })) {
    sendJson(res, 401, []);
    return;
  }

  const body: unknown =
    req.method === 'POST'
      ? safeParseJson(rawBody)
      : Object.fromEntries(url.searchParams);
  const answer = parseVonageAnswerWebhook(body);
  if (!answer) {
    logger.warn(
      { remoteIp, path: url.pathname },
      'Vonage answer webhook rejected: missing call uuid',
    );
    sendJson(res, 400, []);
    return;
  }

  if (!isVonageRuntimeAvailable()) {
    logger.warn(
      { remoteIp, callUuid: answer.uuid },
      'Vonage answer webhook rejected: runtime unavailable',
    );
    sendJson(res, 200, unavailableNcco(language));
    return;
  }

  const session = sessionStore.getOrCreateFromWebhook({
    callSid: answer.uuid,
    remoteIp,
    from: answer.from,
    to: answer.to,
  });
  if (!session) {
    sendJson(res, 200, busyNcco(language));
    return;
  }
  session.providerSessionId = answer.conversationUuid;
  const callState = getCallState(answer.uuid);
  callState.regionUrl = answer.regionUrl;
  transitionSession(answer.uuid, 'listening');
  logger.info(
    {
      callUuid: answer.uuid,
      conversationUuid: answer.conversationUuid,
      remoteIp,
      from: answer.from,
      to: answer.to,
    },
    'Vonage answer webhook accepted',
  );
  sendJson(
    res,
    200,
    buildReplyNcco({
      text: voiceConfig.relay.welcomeGreeting,
      language,
      interruptible: voiceConfig.relay.interruptible,
      inputEventUrl: resolveInputEventUrl(req),
    }),
  );
}

async function handleInputWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  remoteIp: string,
): Promise<void> {
  const voiceConfig = getConfigSnapshot().voice;
  const language = voiceConfig.relay.language;
  const rawBody = await readRawBody(req);
  if (rawBody === null) {
    sendJson(res, 413, []);
    return;
  }
  if (!validateSignedWebhook({ req, rawBody, remoteIp, path: url.pathname })) {
    sendJson(res, 401, []);
    return;
  }

  const input = parseVonageInputWebhook(safeParseJson(rawBody));
  if (!input) {
    sendJson(res, 400, []);
    return;
  }
  const session = sessionStore.get(input.uuid);
  if (!session || !isVonageRuntimeAvailable()) {
    logger.warn(
      { remoteIp, callUuid: input.uuid, hasSession: Boolean(session) },
      'Vonage input webhook without live session; ending call',
    );
    sendJson(res, 200, unavailableNcco(language));
    return;
  }

  const callState = getCallState(input.uuid);
  const speechSettings = {
    language,
    inputEventUrl: resolveInputEventUrl(req),
  };

  const content = input.transcript.trim()
    ? input.transcript.trim()
    : input.dtmfDigits
      ? `The caller pressed the keypad digits "${input.dtmfDigits}".`
      : '';

  if (!content) {
    if (session.state === 'thinking' || session.state === 'speaking') {
      // Agent turn still running; keep the call parked and listening.
      sendJson(res, 200, buildParkNcco(speechSettings));
      return;
    }
    callState.silentTimeouts += 1;
    if (callState.silentTimeouts >= MAX_SILENT_TIMEOUTS) {
      logger.info(
        { callUuid: input.uuid },
        'Vonage call ended after repeated silence',
      );
      transitionSession(input.uuid, 'ending');
      sendJson(
        res,
        200,
        buildGoodbyeNcco({ message: 'Goodbye for now.', language }),
      );
      return;
    }
    sendJson(res, 200, buildParkNcco(speechSettings));
    return;
  }

  callState.silentTimeouts = 0;
  logger.debug(
    { callUuid: input.uuid, promptLength: content.length },
    'Vonage voice transcript received',
  );
  void dispatchTranscript(session, content, speechSettings.inputEventUrl).catch(
    (error) => {
      logger.warn(
        { error, callUuid: input.uuid },
        'Vonage voice dispatch failed',
      );
    },
  );
  sendJson(res, 200, buildParkNcco(speechSettings));
}

async function handleEventWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  remoteIp: string,
): Promise<void> {
  const rawBody = await readRawBody(req);
  if (rawBody === null) {
    sendJson(res, 413, {});
    return;
  }
  if (!validateSignedWebhook({ req, rawBody, remoteIp, path: url.pathname })) {
    sendJson(res, 401, {});
    return;
  }

  const event = parseVonageEventWebhook(safeParseJson(rawBody));
  if (!event) {
    sendJson(res, 200, {});
    return;
  }
  logger.info(
    {
      callUuid: event.uuid,
      conversationUuid: event.conversationUuid,
      status: event.status,
      remoteIp,
    },
    'Vonage call event received',
  );
  if (VONAGE_TERMINAL_CALL_STATUSES.has(event.status)) {
    const session = sessionStore.get(event.uuid);
    if (session) {
      transitionSession(
        event.uuid,
        event.status === 'completed' ? 'ended' : 'failed',
      );
      removeSession(event.uuid);
    }
  }
  sendJson(res, 200, {});
}

function safeParseJson(raw: string): unknown {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

export function initVonageVoice(messageHandler: VoiceMessageHandler): void {
  voiceMessageHandler = messageHandler;
  draining = false;
  runtimeInitialized = true;
  sessionStore.updateLimits(getConfigSnapshot().voice.maxConcurrentCalls);
}

export async function handleVonageVoiceWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const paths = resolveVoiceWebhookPaths(getConfigSnapshot().voice.webhookPath);
  const remoteIp = resolveRemoteIp(req);

  if (url.pathname === paths.answerPath) {
    if (req.method !== 'POST' && req.method !== 'GET') return false;
    await handleAnswerWebhook(req, res, url, remoteIp);
    return true;
  }
  if (url.pathname === paths.inputPath && req.method === 'POST') {
    await handleInputWebhook(req, res, url, remoteIp);
    return true;
  }
  if (url.pathname === paths.eventPath && req.method === 'POST') {
    await handleEventWebhook(req, res, url, remoteIp);
    return true;
  }
  return false;
}

export async function shutdownVonageVoice(opts?: {
  drain?: boolean;
}): Promise<void> {
  draining = true;
  if (opts?.drain) {
    const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
    while (sessionStore.activeCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
    }
  }

  const voiceConfig = getConfigSnapshot().voice;
  await Promise.all(
    sessionStore.list().map(async (session) => {
      session.controller?.abort();
      try {
        await transferVonageCallToNcco({
          applicationId: voiceConfig.vonage.applicationId,
          privateKey: VONAGE_PRIVATE_KEY,
          callUuid: session.callSid,
          ncco: buildGoodbyeNcco({
            message: 'HybridClaw voice is restarting. Goodbye for now.',
            language: voiceConfig.relay.language,
          }),
          regionUrl: getCallState(session.callSid).regionUrl,
        });
      } catch (error) {
        logger.debug(
          { error, callUuid: session.callSid },
          'Vonage shutdown goodbye transfer failed',
        );
      }
      removeSession(session.callSid);
    }),
  );
  runtimeInitialized = false;
  voiceMessageHandler = null;
}
