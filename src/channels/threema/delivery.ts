import {
  getConfigSnapshot,
  THREEMA_GATEWAY_SECRET,
} from '../../config/config.js';
import { classifyGatewayError } from '../../gateway/gateway-error-utils.js';
import { chunkMessage } from '../../memory/chunk.js';
import { sleep } from '../../utils/sleep.js';
import { withTransportRetry } from '../../utils/transport-retry.js';
import { sendThreemaSimpleText, ThreemaApiError } from './api.js';
import { parseThreemaTarget } from './target.js';

const THREEMA_RETRY_MAX_ATTEMPTS = 6;
const THREEMA_RETRY_BASE_DELAY_MS = 500;
const THREEMA_RETRY_MAX_DELAY_MS = 10_000;
const threemaOutboundQueues = new Map<string, Promise<void>>();

type ThreemaDeliveryConfig = {
  apiBaseUrl: string;
  identity: string;
  outboundDelayMs: number;
  secret: string;
  textChunkLimit: number;
};

function normalizeTextChunkLimit(value: unknown): number {
  const parsed = Number(value ?? 3_500);
  const chunkLimit = Number.isFinite(parsed) ? Math.floor(parsed) : 3_500;
  return Math.max(200, Math.min(3_500, chunkLimit));
}

function normalizeOutboundDelayMs(value: unknown): number {
  const parsed = Number(value ?? 350);
  const outboundDelayMs = Number.isFinite(parsed) ? Math.floor(parsed) : 350;
  return Math.max(0, Math.min(10_000, outboundDelayMs));
}

function resolveDeliveryConfig(): ThreemaDeliveryConfig {
  const config = getConfigSnapshot().threema;
  const identity = String(config?.identity || '').trim();
  const secret = String(THREEMA_GATEWAY_SECRET || config?.secret || '').trim();
  if (!config?.enabled || config?.dmPolicy === 'disabled') {
    throw new Error('Threema channel is disabled.');
  }
  if (!identity) {
    throw new Error('Threema Gateway identity is not configured.');
  }
  if (!secret) {
    throw new Error('Threema Gateway secret is not configured.');
  }
  return {
    apiBaseUrl: config?.apiBaseUrl || '',
    identity,
    outboundDelayMs: normalizeOutboundDelayMs(config?.outboundDelayMs),
    secret,
    textChunkLimit: normalizeTextChunkLimit(config?.textChunkLimit),
  };
}

function isRetryableThreemaError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (error instanceof ThreemaApiError) {
    if (error.statusCode === 429) return true;
    if (error.statusCode >= 500 && error.statusCode <= 599) return true;
    if (error.statusCode === 0) return true;
  }
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return classifyGatewayError(text) === 'transient';
}

async function withThreemaTransportRetry<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  return withTransportRetry(label, run, {
    maxAttempts: THREEMA_RETRY_MAX_ATTEMPTS,
    baseDelayMs: THREEMA_RETRY_BASE_DELAY_MS,
    maxDelayMs: THREEMA_RETRY_MAX_DELAY_MS,
    isRetryable: isRetryableThreemaError,
    logMessage: 'Threema transport failed; retrying',
  });
}

function queueThreemaOutboundDelivery<T>(
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = threemaOutboundQueues.get(target) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(run);
  const sentinel = task.then(
    () => undefined,
    () => undefined,
  );
  // The sentinel tracks queue position while task preserves the caller result.
  threemaOutboundQueues.set(target, sentinel);
  void sentinel.finally(() => {
    if (threemaOutboundQueues.get(target) === sentinel) {
      threemaOutboundQueues.delete(target);
    }
  });
  return task;
}

export function prepareThreemaTextChunks(
  text: string,
  maxChars = 3_500,
): string[] {
  const formatted = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const chunks = chunkMessage(formatted, {
    maxChars,
    maxLines: 100,
  }).filter((chunk) => chunk.trim().length > 0);
  return chunks.length > 0 ? chunks : ['(no content)'];
}

export async function sendChunkedThreemaText(params: {
  signal?: AbortSignal;
  target: string;
  text: string;
}): Promise<void> {
  const target = parseThreemaTarget(params.target);
  if (!target) {
    throw new Error(`Invalid Threema target: ${params.target}`);
  }
  await queueThreemaOutboundDelivery(
    `threema:${target.kind}:${target.recipient}`,
    async () => {
      const config = resolveDeliveryConfig();
      const chunks = prepareThreemaTextChunks(
        params.text,
        config.textChunkLimit,
      );
      for (let index = 0; index < chunks.length; index += 1) {
        params.signal?.throwIfAborted();
        await withThreemaTransportRetry('threema.sendChunkedText', () =>
          sendThreemaSimpleText({
            apiBaseUrl: config.apiBaseUrl,
            identity: config.identity,
            secret: config.secret,
            signal: params.signal,
            target,
            text: chunks[index],
          }),
        );
        if (index < chunks.length - 1) {
          await sleep(config.outboundDelayMs);
        }
      }
    },
  );
}
