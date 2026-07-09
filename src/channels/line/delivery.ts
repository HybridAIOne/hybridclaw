import { getConfigSnapshot } from '../../config/config.js';
import { classifyGatewayError } from '../../gateway/gateway-error-utils.js';
import { chunkMessage } from '../../memory/chunk.js';
import { withTransportRetry } from '../../utils/transport-retry.js';
import { callLineApi, LineApiError, type LineTextMessage } from './api.js';
import { parseLineTarget } from './target.js';

const LINE_MAX_MESSAGES_PER_REQUEST = 5;
const LINE_RETRY_MAX_ATTEMPTS = 8;
const LINE_RETRY_BASE_DELAY_MS = 500;
const LINE_RETRY_MAX_DELAY_MS = 15_000;
const lineOutboundQueues = new Map<string, Promise<void>>();

function resolveTextChunkLimit(): number {
  return Math.max(
    200,
    Math.min(
      5_000,
      Math.floor(getConfigSnapshot().line?.textChunkLimit ?? 5_000),
    ),
  );
}

function getLineErrorStatus(error: unknown): number | null {
  if (error instanceof LineApiError) {
    return error.statusCode;
  }
  if (typeof error !== 'object' || error == null) return null;
  const maybe = error as {
    status?: unknown;
    statusCode?: unknown;
    httpStatus?: unknown;
  };
  const status = maybe.status ?? maybe.statusCode ?? maybe.httpStatus;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function isRetryableLineError(error: unknown): boolean {
  const status = getLineErrorStatus(error);
  if (status === 429 || (status !== null && status >= 500 && status <= 599)) {
    return true;
  }
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return classifyGatewayError(text) === 'transient';
}

async function withLineTransportRetry<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  return await withTransportRetry(label, run, {
    maxAttempts: LINE_RETRY_MAX_ATTEMPTS,
    baseDelayMs: LINE_RETRY_BASE_DELAY_MS,
    maxDelayMs: LINE_RETRY_MAX_DELAY_MS,
    isRetryable: isRetryableLineError,
    logMessage: 'LINE transport failed; retrying',
  });
}

function queueLineOutboundDelivery<T>(
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = lineOutboundQueues.get(target) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(run);
  const sentinel = task.then(
    () => undefined,
    () => undefined,
  );
  lineOutboundQueues.set(target, sentinel);
  void sentinel.finally(() => {
    if (lineOutboundQueues.get(target) === sentinel) {
      lineOutboundQueues.delete(target);
    }
  });
  return task;
}

export function prepareLineTextMessages(text: string): LineTextMessage[] {
  const formatted = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const chunks = chunkMessage(formatted, {
    maxChars: resolveTextChunkLimit(),
    maxLines: 200,
  }).filter((chunk) => chunk.trim().length > 0);
  const resolvedChunks = chunks.length > 0 ? chunks : ['(no content)'];
  return resolvedChunks.map((chunk) => ({
    type: 'text',
    text: chunk,
  }));
}

async function sendLineReplyMessages(params: {
  channelAccessToken: string;
  replyToken: string;
  messages: LineTextMessage[];
  signal?: AbortSignal;
}): Promise<void> {
  await withLineTransportRetry(
    'line.reply',
    async () =>
      await callLineApi(
        params.channelAccessToken,
        'message/reply',
        {
          replyToken: params.replyToken,
          messages: params.messages,
        },
        params.signal,
      ),
  );
}

async function sendLinePushMessages(params: {
  channelAccessToken: string;
  target: string;
  messages: LineTextMessage[];
  signal?: AbortSignal;
}): Promise<void> {
  const target = parseLineTarget(params.target);
  if (!target) {
    throw new Error(`Invalid LINE target: ${params.target}`);
  }

  await withLineTransportRetry(
    'line.push',
    async () =>
      await callLineApi(
        params.channelAccessToken,
        'message/push',
        {
          to: target.recipient,
          messages: params.messages,
        },
        params.signal,
      ),
  );
}

export async function sendChunkedLineText(params: {
  channelAccessToken: string;
  target: string;
  text: string;
  signal?: AbortSignal;
}): Promise<void> {
  const target = parseLineTarget(params.target);
  if (!target) {
    throw new Error(`Invalid LINE target: ${params.target}`);
  }

  await queueLineOutboundDelivery(params.target, async () => {
    const messages = prepareLineTextMessages(params.text);
    for (
      let index = 0;
      index < messages.length;
      index += LINE_MAX_MESSAGES_PER_REQUEST
    ) {
      await sendLinePushMessages({
        channelAccessToken: params.channelAccessToken,
        target: params.target,
        messages: messages.slice(index, index + LINE_MAX_MESSAGES_PER_REQUEST),
        signal: params.signal,
      });
    }
  });
}

function isInvalidReplyTokenError(error: unknown): boolean {
  if (!(error instanceof LineApiError)) return false;
  return (
    error.statusCode === 400 &&
    /invalid reply token|reply token/i.test(error.description)
  );
}

export async function sendLineTextForReply(params: {
  channelAccessToken: string;
  target: string;
  replyToken?: string | null;
  text: string;
  signal?: AbortSignal;
}): Promise<void> {
  const messages = prepareLineTextMessages(params.text);
  if (!params.replyToken) {
    await sendChunkedLineText(params);
    return;
  }

  const replyMessages = messages.slice(0, LINE_MAX_MESSAGES_PER_REQUEST);
  const remainingMessages = messages.slice(LINE_MAX_MESSAGES_PER_REQUEST);

  try {
    await sendLineReplyMessages({
      channelAccessToken: params.channelAccessToken,
      replyToken: params.replyToken,
      messages: replyMessages,
      signal: params.signal,
    });
  } catch (error) {
    if (!isInvalidReplyTokenError(error)) throw error;
    await sendChunkedLineText(params);
    return;
  }

  for (
    let index = 0;
    index < remainingMessages.length;
    index += LINE_MAX_MESSAGES_PER_REQUEST
  ) {
    await sendLinePushMessages({
      channelAccessToken: params.channelAccessToken,
      target: params.target,
      messages: remainingMessages.slice(
        index,
        index + LINE_MAX_MESSAGES_PER_REQUEST,
      ),
      signal: params.signal,
    });
  }
}
