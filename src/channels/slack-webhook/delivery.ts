import { classifyGatewayError } from '../../gateway/gateway-error-utils.js';
import { withTransportRetry } from '../../utils/transport-retry.js';
import { chunkSlackText } from '../slack/delivery.js';
import { resolveSlackWebhookConfig } from './config.js';
import {
  parseSlackWebhookChannelTarget,
  SLACK_WEBHOOK_DEFAULT_TARGET,
} from './target.js';

const SLACK_WEBHOOK_BLOCK_TEXT_LIMIT = 3_000;
const SLACK_WEBHOOK_RETRY_MAX_ATTEMPTS = 5;
const SLACK_WEBHOOK_RETRY_BASE_DELAY_MS = 500;
const SLACK_WEBHOOK_RETRY_MAX_DELAY_MS = 10_000;
const slackWebhookOutboundQueues = new Map<string, Promise<unknown>>();
const slackWebhookLastResults = new Map<string, SlackWebhookSendResult>();
const slackWebhookLastReachabilityResults = new Map<
  string,
  SlackWebhookSendResult
>();

export interface SlackWebhookTargetConfig {
  webhookUrl: string;
  defaultUsername: string;
  defaultIconEmoji: string;
  // Slack still accepts icon_url for legacy/custom webhook integrations.
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

function resolveSlackWebhookTarget(target: string): SlackWebhookTargetConfig {
  const config = resolveSlackWebhookConfig({
    requireDefaultTarget: true,
    requireEnabled: true,
  });
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
  return chunkSlackText(normalizeWebhookText(text), {
    maxChars: SLACK_WEBHOOK_BLOCK_TEXT_LIMIT,
    maxLines: 100,
  });
}

export function buildSlackWebhookPayload(
  text: string,
  targetConfig?: Partial<SlackWebhookTargetConfig>,
): SlackWebhookPayload {
  const chunks = prepareSlackWebhookTextBlocks(text);
  const fallback = chunks.join('\n\n');
  const payload: SlackWebhookPayload = {
    text: fallback,
    blocks: chunks.map((chunk) => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: chunk,
      },
    })),
  };
  if (targetConfig?.defaultUsername) {
    payload.username = targetConfig.defaultUsername;
  }
  if (targetConfig?.defaultIconEmoji) {
    payload.icon_emoji = targetConfig.defaultIconEmoji;
  }
  if (targetConfig?.defaultIconUrl) {
    payload.icon_url = targetConfig.defaultIconUrl;
  }
  return payload;
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
  slackWebhookOutboundQueues.set(target, task);
  void task
    .finally(() => {
      if (slackWebhookOutboundQueues.get(target) === task) {
        slackWebhookOutboundQueues.delete(target);
      }
    })
    .catch(() => {});
  return task;
}

function resolveDeliveryTarget(raw: string): string {
  const parsed =
    parseSlackWebhookChannelTarget(raw) ||
    parseSlackWebhookChannelTarget(`slack_webhook:${raw}`);
  return parsed?.target || SLACK_WEBHOOK_DEFAULT_TARGET;
}

export async function sendSlackWebhookText(params: {
  signal?: AbortSignal;
  target: string;
  text: string;
}): Promise<void> {
  const target = resolveDeliveryTarget(params.target);
  const webhook = resolveSlackWebhookTarget(target);

  await queueSlackWebhookOutboundDelivery(target, async () => {
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
  const target = resolveDeliveryTarget(params.target);
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
  return [...slackWebhookLastResults.values()];
}

export function getSlackWebhookLastReachabilityResults(): SlackWebhookSendResult[] {
  return [...slackWebhookLastReachabilityResults.values()];
}

export function clearSlackWebhookRuntimeResults(): void {
  slackWebhookLastResults.clear();
  slackWebhookLastReachabilityResults.clear();
}
