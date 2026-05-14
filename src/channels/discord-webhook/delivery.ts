import { classifyGatewayError } from '../../gateway/gateway-error-utils.js';
import { chunkMessage } from '../../memory/chunk.js';
import { withTransportRetry } from '../../utils/transport-retry.js';
import { resolveDiscordWebhookConfig } from './config.js';
import {
  DISCORD_WEBHOOK_DEFAULT_TARGET,
  parseDiscordWebhookChannelTarget,
} from './target.js';

const DISCORD_WEBHOOK_CONTENT_LIMIT = 2_000;
const DISCORD_WEBHOOK_RETRY_MAX_ATTEMPTS = 5;
const DISCORD_WEBHOOK_RETRY_BASE_DELAY_MS = 500;
const DISCORD_WEBHOOK_RETRY_MAX_DELAY_MS = 10_000;
const discordWebhookOutboundQueues = new Map<string, Promise<unknown>>();
const discordWebhookLastResults = new Map<string, DiscordWebhookSendResult>();
const discordWebhookLastReachabilityResults = new Map<
  string,
  DiscordWebhookSendResult
>();

export interface DiscordWebhookTargetConfig {
  webhookUrl: string;
  defaultUsername: string;
  defaultAvatarUrl: string;
}

export interface DiscordWebhookSendResult {
  target: string;
  ok: boolean;
  at: string;
  statusCode: number | null;
  error: string | null;
}

export interface DiscordWebhookPayload {
  content: string;
  username?: string;
  avatar_url?: string;
  allowed_mentions: {
    parse: [];
  };
}

export class DiscordWebhookApiError extends Error {
  public readonly retryAfterMs: number | null;

  constructor(
    message: string,
    public readonly statusCode: number,
    retryAfterMs?: number | null,
  ) {
    super(message);
    this.name = 'DiscordWebhookApiError';
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

function resolveDiscordWebhookTarget(
  target: string,
): DiscordWebhookTargetConfig {
  const config = resolveDiscordWebhookConfig({
    requireDefaultTarget: true,
    requireEnabled: true,
  });
  const normalizedTarget = target || DISCORD_WEBHOOK_DEFAULT_TARGET;
  const webhook = config.webhooks[normalizedTarget];
  if (!webhook?.webhookUrl) {
    throw new Error(
      `Discord webhook target is not configured: ${normalizedTarget}`,
    );
  }
  return webhook;
}

function normalizeWebhookText(text: string): string {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  return normalized || '(no content)';
}

export function prepareDiscordWebhookTextChunks(text: string): string[] {
  const chunks = chunkMessage(normalizeWebhookText(text), {
    maxChars: DISCORD_WEBHOOK_CONTENT_LIMIT,
    maxLines: 100,
  })
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chunks.length > 0 ? chunks : ['(no content)'];
}

export function buildDiscordWebhookPayloads(
  text: string,
  targetConfig?: Partial<DiscordWebhookTargetConfig>,
): DiscordWebhookPayload[] {
  return prepareDiscordWebhookTextChunks(text).map((chunk) => {
    const payload: DiscordWebhookPayload = {
      content: chunk,
      allowed_mentions: { parse: [] },
    };
    if (targetConfig?.defaultUsername) {
      payload.username = targetConfig.defaultUsername;
    }
    if (targetConfig?.defaultAvatarUrl) {
      payload.avatar_url = targetConfig.defaultAvatarUrl;
    }
    return payload;
  });
}

async function parseRetryAfterMs(response: Response): Promise<number | null> {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) {
    const headerSeconds = Number(retryAfter);
    if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
      return Math.ceil(headerSeconds * 1_000);
    }
  }

  if (response.status !== 429) return null;
  try {
    const body = (await response.clone().json()) as { retry_after?: unknown };
    const bodySeconds = Number(body.retry_after);
    if (Number.isFinite(bodySeconds) && bodySeconds >= 0) {
      return Math.ceil(bodySeconds * 1_000);
    }
  } catch {
    return null;
  }
  return null;
}

async function postDiscordWebhook(params: {
  payload: DiscordWebhookPayload;
  signal?: AbortSignal;
  webhookUrl: string;
}): Promise<void> {
  const response = await fetch(params.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(params.payload),
    signal: params.signal,
  });
  if (response.ok) return;

  throw new DiscordWebhookApiError(
    `Discord webhook POST failed with HTTP ${response.status}`,
    response.status,
    await parseRetryAfterMs(response),
  );
}

function isRetryableDiscordWebhookError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (error instanceof DiscordWebhookApiError) {
    if (error.statusCode === 429) return true;
    return error.statusCode >= 500 && error.statusCode <= 599;
  }
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return classifyGatewayError(text) === 'transient';
}

function extractDiscordWebhookRetryAfterMs(
  error: unknown,
  fallbackMs: number,
): number {
  if (
    error instanceof DiscordWebhookApiError &&
    typeof error.retryAfterMs === 'number'
  ) {
    return error.retryAfterMs;
  }
  return fallbackMs;
}

function recordDiscordWebhookSendResult(
  target: string,
  result: Omit<DiscordWebhookSendResult, 'target' | 'at'>,
): void {
  discordWebhookLastResults.set(target, {
    target,
    at: new Date().toISOString(),
    ...result,
  });
}

function queueDiscordWebhookOutboundDelivery<T>(
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous =
    discordWebhookOutboundQueues.get(target) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(run);
  discordWebhookOutboundQueues.set(target, task);
  void task
    .finally(() => {
      if (discordWebhookOutboundQueues.get(target) === task) {
        discordWebhookOutboundQueues.delete(target);
      }
    })
    .catch(() => {});
  return task;
}

function resolveDeliveryTarget(raw: string): string {
  const parsed =
    parseDiscordWebhookChannelTarget(raw) ||
    parseDiscordWebhookChannelTarget(`discord_webhook:${raw}`);
  return parsed?.target || DISCORD_WEBHOOK_DEFAULT_TARGET;
}

export async function sendDiscordWebhookText(params: {
  signal?: AbortSignal;
  target: string;
  text: string;
}): Promise<void> {
  const target = resolveDeliveryTarget(params.target);
  const webhook = resolveDiscordWebhookTarget(target);

  await queueDiscordWebhookOutboundDelivery(target, async () => {
    const payloads = buildDiscordWebhookPayloads(params.text, webhook);
    try {
      for (const payload of payloads) {
        await withTransportRetry(
          'discordWebhook.send',
          () =>
            postDiscordWebhook({
              payload,
              signal: params.signal,
              webhookUrl: webhook.webhookUrl,
            }),
          {
            maxAttempts: DISCORD_WEBHOOK_RETRY_MAX_ATTEMPTS,
            baseDelayMs: DISCORD_WEBHOOK_RETRY_BASE_DELAY_MS,
            maxDelayMs: DISCORD_WEBHOOK_RETRY_MAX_DELAY_MS,
            isRetryable: isRetryableDiscordWebhookError,
            extractRetryAfter: extractDiscordWebhookRetryAfterMs,
            logMessage: 'Discord webhook transport failed; retrying',
          },
        );
      }
      recordDiscordWebhookSendResult(target, {
        ok: true,
        statusCode: 204,
        error: null,
      });
    } catch (error) {
      recordDiscordWebhookSendResult(target, {
        ok: false,
        statusCode:
          error instanceof DiscordWebhookApiError ? error.statusCode : null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

export async function pingDiscordWebhookTarget(params: {
  signal?: AbortSignal;
  target: string;
}): Promise<DiscordWebhookSendResult> {
  const target = resolveDeliveryTarget(params.target);
  const webhook = resolveDiscordWebhookTarget(target);
  const at = new Date().toISOString();

  try {
    await postDiscordWebhook({
      payload: buildDiscordWebhookPayloads(
        'HybridClaw Discord webhook reachability check.',
        webhook,
      )[0],
      signal: params.signal,
      webhookUrl: webhook.webhookUrl,
    });
    const result = {
      target,
      ok: true,
      at,
      statusCode: 204,
      error: null,
    } satisfies DiscordWebhookSendResult;
    discordWebhookLastReachabilityResults.set(target, result);
    return result;
  } catch (error) {
    const result = {
      target,
      ok: false,
      at,
      statusCode:
        error instanceof DiscordWebhookApiError ? error.statusCode : null,
      error: error instanceof Error ? error.message : String(error),
    } satisfies DiscordWebhookSendResult;
    discordWebhookLastReachabilityResults.set(target, result);
    return result;
  }
}

export function getDiscordWebhookLastSendResults(): DiscordWebhookSendResult[] {
  return [...discordWebhookLastResults.values()];
}

export function getDiscordWebhookLastReachabilityResults(): DiscordWebhookSendResult[] {
  return [...discordWebhookLastReachabilityResults.values()];
}

export function clearDiscordWebhookRuntimeResults(): void {
  discordWebhookLastResults.clear();
  discordWebhookLastReachabilityResults.clear();
}
