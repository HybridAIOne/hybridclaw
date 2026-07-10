import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import {
  getConfigSnapshot,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
} from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types/container.js';
import { LINE_CAPABILITIES } from '../channel.js';
import { registerChannel, unregisterChannel } from '../channel-registry.js';
import { sendChunkedLineText, sendLineTextForReply } from './delivery.js';
import { type LineWebhookEvent, processInboundLineEvent } from './inbound.js';

export type LineReplyFn = (content: string) => Promise<void>;

export interface LineMessageContext {
  abortSignal: AbortSignal;
  event: LineWebhookEvent;
}

export type LineMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: LineReplyFn,
  context: LineMessageContext,
) => Promise<void>;

const MAX_LINE_WEBHOOK_BYTES = 1_000_000;
let runtimeInitialized = false;
let shutdownController: AbortController | null = null;
let activeLineConfig: ReturnType<typeof getConfigSnapshot>['line'] | null =
  null;
let activeMessageHandler: LineMessageHandler | null = null;
let activeChannelAccessToken: string | null = null;
let activeChannelSecret: string | null = null;
const inFlightControllers = new Set<AbortController>();
const inFlightTasks = new Set<Promise<void>>();

function resolveLineConfig() {
  return getConfigSnapshot().line;
}

export function hasLineCredentials(): boolean {
  const config = resolveLineConfig();
  return Boolean(
    String(
      LINE_CHANNEL_ACCESS_TOKEN || config.channelAccessToken || '',
    ).trim() &&
      String(LINE_CHANNEL_SECRET || config.channelSecret || '').trim(),
  );
}

function resolveChannelAccessToken(
  config: ReturnType<typeof getConfigSnapshot>['line'] = resolveLineConfig(),
): string {
  const token = String(
    LINE_CHANNEL_ACCESS_TOKEN || config.channelAccessToken || '',
  ).trim();
  if (!token) {
    throw new Error('LINE channel access token is not configured.');
  }
  return token;
}

function resolveChannelSecret(
  config: ReturnType<typeof getConfigSnapshot>['line'] = resolveLineConfig(),
): string {
  const secret = String(
    LINE_CHANNEL_SECRET || config.channelSecret || '',
  ).trim();
  if (!secret) {
    throw new Error('LINE channel secret is not configured.');
  }
  return secret;
}

function resolveActiveLineConfig(): ReturnType<
  typeof getConfigSnapshot
>['line'] {
  return runtimeInitialized && activeLineConfig
    ? activeLineConfig
    : resolveLineConfig();
}

function resolveActiveChannelAccessToken(): string {
  return runtimeInitialized && activeChannelAccessToken
    ? activeChannelAccessToken
    : resolveChannelAccessToken();
}

function resolveActiveChannelSecret(): string {
  return runtimeInitialized && activeChannelSecret
    ? activeChannelSecret
    : resolveChannelSecret();
}

function createLineShutdownAbortError(): Error {
  return new Error('LINE runtime shutting down.');
}

function abortInFlightHandlers(): void {
  for (const controller of inFlightControllers) {
    if (controller.signal.aborted) continue;
    controller.abort(createLineShutdownAbortError());
  }
}

async function readLineWebhookBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_LINE_WEBHOOK_BYTES) {
      throw new Error('LINE webhook body too large.');
    }
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function sendLineWebhookResponse(
  res: ServerResponse,
  statusCode: number,
  body?: Record<string, unknown>,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.statusCode = statusCode;
  if (body) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return;
  }
  res.end();
}

function getLineSignatureHeader(req: IncomingMessage): string {
  const value = req.headers['x-line-signature'];
  if (Array.isArray(value)) return value[0] || '';
  return String(value || '').trim();
}

export function verifyLineWebhookSignature(params: {
  body: Buffer;
  channelSecret: string;
  signature: string;
}): boolean {
  const signature = String(params.signature || '').trim();
  if (!signature) return false;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = createHmac('sha256', params.channelSecret)
      .update(params.body)
      .digest();
    actual = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function dispatchLineEvent(
  event: LineWebhookEvent,
  messageHandler: LineMessageHandler,
): Promise<void> {
  const lineConfig = resolveActiveLineConfig();
  const inbound = processInboundLineEvent({
    config: lineConfig,
    event,
    agentId: DEFAULT_AGENT_ID,
  });
  if (!inbound) return;

  const controller = new AbortController();
  inFlightControllers.add(controller);
  if (shutdownController?.signal.aborted && !controller.signal.aborted) {
    controller.abort(createLineShutdownAbortError());
  }

  const reply: LineReplyFn = async (content) => {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : createLineShutdownAbortError();
    }
    await sendLineTextForReply({
      channelAccessToken: resolveActiveChannelAccessToken(),
      target: inbound.channelId,
      replyToken: event.replyToken,
      text: content,
      signal: controller.signal,
    });
  };

  try {
    await messageHandler(
      inbound.sessionId,
      inbound.guildId,
      inbound.channelId,
      inbound.userId,
      inbound.username,
      inbound.content,
      inbound.media,
      reply,
      {
        abortSignal: controller.signal,
        event,
      },
    );
  } finally {
    inFlightControllers.delete(controller);
  }
}

function isLineWebhookEvent(value: unknown): value is LineWebhookEvent {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function dispatchLineEvents(events: unknown[]): void {
  const handler = activeMessageHandler;
  if (!handler || shutdownController?.signal.aborted) return;

  const task = Promise.all(
    events.map(async (event) => {
      if (!isLineWebhookEvent(event)) {
        logger.warn('Ignored malformed LINE webhook event');
        return;
      }
      try {
        await dispatchLineEvent(event, handler);
      } catch (error) {
        if (!shutdownController?.signal.aborted) {
          logger.warn(
            {
              error,
              eventType: event.type,
              webhookEventId: event.webhookEventId,
            },
            'LINE webhook event processing failed',
          );
        }
      }
    }),
  ).then(() => undefined);
  inFlightTasks.add(task);
  void task
    .catch((error) => {
      if (!shutdownController?.signal.aborted) {
        logger.warn({ error }, 'LINE webhook event processing failed');
      }
    })
    .finally(() => {
      inFlightTasks.delete(task);
    });
}

export async function initLine(
  messageHandler: LineMessageHandler,
): Promise<void> {
  if (runtimeInitialized) return;

  const lineConfig = resolveLineConfig();
  const channelAccessToken = resolveChannelAccessToken(lineConfig);
  const channelSecret = resolveChannelSecret(lineConfig);
  registerChannel({
    kind: 'line',
    id: 'line',
    capabilities: LINE_CAPABILITIES,
  });

  activeLineConfig = lineConfig;
  activeChannelAccessToken = channelAccessToken;
  activeChannelSecret = channelSecret;
  activeMessageHandler = messageHandler;
  shutdownController = new AbortController();
  runtimeInitialized = true;
}

export async function handleLineWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!runtimeInitialized || !activeMessageHandler) {
    sendLineWebhookResponse(res, 503, {
      error: 'LINE runtime is not initialized.',
    });
    return false;
  }

  let body: Buffer;
  try {
    body = await readLineWebhookBody(req);
  } catch (error) {
    logger.warn({ error }, 'Rejected oversized LINE webhook body');
    sendLineWebhookResponse(res, 413, { error: 'Request body too large.' });
    return false;
  }

  const signature = getLineSignatureHeader(req);
  if (
    !verifyLineWebhookSignature({
      body,
      channelSecret: resolveActiveChannelSecret(),
      signature,
    })
  ) {
    sendLineWebhookResponse(res, 401, { error: 'Invalid LINE signature.' });
    return false;
  }

  let payload: unknown;
  try {
    payload =
      body.length > 0 ? (JSON.parse(body.toString('utf8')) as unknown) : {};
  } catch {
    sendLineWebhookResponse(res, 400, { error: 'Invalid JSON body.' });
    return false;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendLineWebhookResponse(res, 400, {
      error: 'LINE webhook body must be a JSON object.',
    });
    return false;
  }
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    sendLineWebhookResponse(res, 400, {
      error: 'LINE webhook events must be an array.',
    });
    return false;
  }

  sendLineWebhookResponse(res, 200);
  if (events.length > 0) {
    dispatchLineEvents(events);
  }
  return true;
}

export async function sendToLineChat(
  target: string,
  text: string,
): Promise<void> {
  await sendChunkedLineText({
    channelAccessToken: resolveActiveChannelAccessToken(),
    target,
    text,
    signal: shutdownController?.signal,
  });
}

export async function shutdownLine(): Promise<void> {
  shutdownController?.abort();
  abortInFlightHandlers();
  await Promise.allSettled(Array.from(inFlightTasks));
  inFlightTasks.clear();
  activeLineConfig = null;
  activeMessageHandler = null;
  activeChannelAccessToken = null;
  activeChannelSecret = null;
  shutdownController = null;
  unregisterChannel('line');
  runtimeInitialized = false;
}
