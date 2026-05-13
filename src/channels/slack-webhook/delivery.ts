import { getConfigSnapshot } from '../../config/config.js';
import { classifyGatewayError } from '../../gateway/gateway-error-utils.js';
import { chunkMessage } from '../../memory/chunk.js';
import { withTransportRetry } from '../../utils/transport-retry.js';
import { formatSlackMrkdwn } from '../slack/delivery.js';
import {
  parseSlackWebhookChannelTarget,
  SLACK_WEBHOOK_DEFAULT_TARGET,
} from './target.js';

const SLACK_WEBHOOK_BLOCK_TEXT_LIMIT = 3_000;
const SLACK_WEBHOOK_RETRY_MAX_ATTEMPTS = 5;
const SLACK_WEBHOOK_RETRY_BASE_DELAY_MS = 500;
const SLACK_WEBHOOK_RETRY_MAX_DELAY_MS = 10_000;
const slackWebhookOutboundQueues = new Map<string, Promise<void>>();
const slackWebhookLastResults = new Map<string, SlackWebhookSendResult>();
const slackWebhookLastReachabilityResults = new Map<
  string,
  SlackWebhookSendResult
>();

export interface SlackWebhookTargetConfig {
  webhookUrl: string;
  defaultUsername: string;
  defaultIconEmoji: string;
  defaultIconUrl: string;
}

export interface SlackWebhookSendResult {
  target: string;
  ok: boolean;
  at: string;
  statusCode: number | null;
  error: string | null;
}

export interface SlackWebhookPayload {
  text: string;
  blocks: Array<{
    type: 'section';
    text: {
      type: 'mrkdwn';
      text: string;
    };
  }>;
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
}

export class SlackWebhookApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'SlackWebhookApiError';
  }
}

function resolveSlackWebhookConfig() {
  const config = getConfigSnapshot().slackWebhook;
  if (!config.enabled) {
    throw new Error('Slack webhook channel is disabled.');
  }
  if (!config.webhooks[SLACK_WEBHOOK_DEFAULT_TARGET]?.webhookUrl) {
    throw new Error('Slack webhook default target is not configured.');
  }
  return config;
}

function resolveSlackWebhookTarget(target: string): SlackWebhookTargetConfig {
  const config = resolveSlackWebhookConfig();
  const normalizedTarget = target || SLACK_WEBHOOK_DEFAULT_TARGET;
  const webhook = config.webhooks[normalizedTarget];
  if (!webhook?.webhookUrl) {
    throw new Error(
      `Slack webhook target is not configured: ${normalizedTarget}`,
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

export function prepareSlackWebhookTextBlocks(text: string): string[] {
  const formatted = formatSlackMrkdwn(normalizeWebhookText(text));
  const chunks = chunkMessage(formatted, {
    maxChars: SLACK_WEBHOOK_BLOCK_TEXT_LIMIT,
    maxLines: 100,
  })
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chunks.length > 0 ? chunks : ['(no content)'];
}

export function buildSlackWebhookPayload(
  text: string,
  targetConfig?: Partial<SlackWebhookTargetConfig>,
): SlackWebhookPayload {
  const chunks = prepareSlackWebhookTextBlocks(text);
  const fallback = chunks.join('\n\n');
  return {
    text: fallback,
    blocks: chunks.map((chunk) => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: chunk,
      },
    })),
    ...(targetConfig?.defaultUsername
      ? { username: targetConfig.defaultUsername }
      : {}),
    ...(targetConfig?.defaultIconEmoji
      ? { icon_emoji: targetConfig.defaultIconEmoji }
      : {}),
    ...(targetConfig?.defaultIconUrl
      ? { icon_url: targetConfig.defaultIconUrl }
      : {}),
  };
}

async function postSlackWebhook(params: {
  payload: SlackWebhookPayload;
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

  let detail = '';
  try {
    detail = (await response.text()).trim().slice(0, 200);
  } catch {
    detail = '';
  }
  throw new SlackWebhookApiError(
    `Slack webhook POST failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    response.status,
  );
}

function isRetryableSlackWebhookError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (error instanceof SlackWebhookApiError) {
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

function recordSlackWebhookSendResult(
  target: string,
  result: Omit<SlackWebhookSendResult, 'target' | 'at'>,
): void {
  slackWebhookLastResults.set(target, {
    target,
    at: new Date().toISOString(),
    ...result,
  });
}

function queueSlackWebhookOutboundDelivery<T>(
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = slackWebhookOutboundQueues.get(target) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(run);
  const sentinel = task.then(
    () => undefined,
    () => undefined,
  );
  slackWebhookOutboundQueues.set(target, sentinel);
  void sentinel.finally(() => {
    if (slackWebhookOutboundQueues.get(target) === sentinel) {
      slackWebhookOutboundQueues.delete(target);
    }
  });
  return task;
}

export async function sendSlackWebhookText(params: {
  signal?: AbortSignal;
  target: string;
  text: string;
}): Promise<void> {
  const parsed =
    parseSlackWebhookChannelTarget(params.target) ||
    parseSlackWebhookChannelTarget(`slack_webhook:${params.target}`);
  const target = parsed?.target || SLACK_WEBHOOK_DEFAULT_TARGET;

  await queueSlackWebhookOutboundDelivery(target, async () => {
    const webhook = resolveSlackWebhookTarget(target);
    const payload = buildSlackWebhookPayload(params.text, webhook);
    try {
      await withTransportRetry(
        'slackWebhook.send',
        () =>
          postSlackWebhook({
            payload,
            signal: params.signal,
            webhookUrl: webhook.webhookUrl,
          }),
        {
          maxAttempts: SLACK_WEBHOOK_RETRY_MAX_ATTEMPTS,
          baseDelayMs: SLACK_WEBHOOK_RETRY_BASE_DELAY_MS,
          maxDelayMs: SLACK_WEBHOOK_RETRY_MAX_DELAY_MS,
          isRetryable: isRetryableSlackWebhookError,
          logMessage: 'Slack webhook transport failed; retrying',
        },
      );
      recordSlackWebhookSendResult(target, {
        ok: true,
        statusCode: 200,
        error: null,
      });
    } catch (error) {
      recordSlackWebhookSendResult(target, {
        ok: false,
        statusCode:
          error instanceof SlackWebhookApiError ? error.statusCode : null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

export async function pingSlackWebhookTarget(params: {
  signal?: AbortSignal;
  target: string;
}): Promise<SlackWebhookSendResult> {
  const parsed =
    parseSlackWebhookChannelTarget(params.target) ||
    parseSlackWebhookChannelTarget(`slack_webhook:${params.target}`);
  const target = parsed?.target || SLACK_WEBHOOK_DEFAULT_TARGET;
  const webhook = resolveSlackWebhookTarget(target);
  const at = new Date().toISOString();

  try {
    await postSlackWebhook({
      payload: buildSlackWebhookPayload(
        'HybridClaw Slack webhook reachability check.',
        webhook,
      ),
      signal: params.signal,
      webhookUrl: webhook.webhookUrl,
    });
    const result = {
      target,
      ok: true,
      at,
      statusCode: 200,
      error: null,
    } satisfies SlackWebhookSendResult;
    slackWebhookLastReachabilityResults.set(target, result);
    return result;
  } catch (error) {
    const result = {
      target,
      ok: false,
      at,
      statusCode:
        error instanceof SlackWebhookApiError ? error.statusCode : null,
      error: error instanceof Error ? error.message : String(error),
    } satisfies SlackWebhookSendResult;
    slackWebhookLastReachabilityResults.set(target, result);
    return result;
  }
}

export function getSlackWebhookLastSendResults(): SlackWebhookSendResult[] {
  return [...slackWebhookLastResults.values()].sort((left, right) =>
    left.target.localeCompare(right.target),
  );
}

export function getSlackWebhookLastReachabilityResults(): SlackWebhookSendResult[] {
  return [...slackWebhookLastReachabilityResults.values()].sort((left, right) =>
    left.target.localeCompare(right.target),
  );
}

export function clearSlackWebhookLastSendResults(): void {
  slackWebhookLastResults.clear();
  slackWebhookLastReachabilityResults.clear();
}
