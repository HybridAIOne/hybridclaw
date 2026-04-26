import { getConfigSnapshot } from '../../config/config.js';
import { classifyGatewayError } from '../../gateway/gateway-error-utils.js';
import { chunkMessage } from '../../memory/chunk.js';
import { sleep } from '../../utils/sleep.js';
import { withTransportRetry } from '../../utils/transport-retry.js';
import { callSignalRpc, SignalRpcError } from './api.js';
import { parseSignalTarget } from './target.js';

const SIGNAL_RETRY_MAX_ATTEMPTS = 6;
const SIGNAL_RETRY_BASE_DELAY_MS = 500;
const SIGNAL_RETRY_MAX_DELAY_MS = 10_000;
const signalOutboundQueues = new Map<string, Promise<void>>();

export interface SignalOutboundMessageRef {
  recipient: string;
  timestamp: number;
}

function resolveTextChunkLimit(): number {
  return Math.max(
    200,
    Math.min(
      8_000,
      Math.floor(getConfigSnapshot().signal?.textChunkLimit ?? 4_000),
    ),
  );
}

function resolveOutboundDelayMs(): number {
  return Math.max(
    0,
    Math.min(
      10_000,
      Math.floor(getConfigSnapshot().signal?.outboundDelayMs ?? 350),
    ),
  );
}

function isRetryableSignalError(error: unknown): boolean {
  if (error instanceof SignalRpcError) {
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

async function withSignalTransportRetry<T>(
  label: string,
  run: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  },
): Promise<T> {
  return withTransportRetry(label, run, {
    maxAttempts: options?.maxAttempts ?? SIGNAL_RETRY_MAX_ATTEMPTS,
    baseDelayMs: options?.baseDelayMs ?? SIGNAL_RETRY_BASE_DELAY_MS,
    maxDelayMs: options?.maxDelayMs ?? SIGNAL_RETRY_MAX_DELAY_MS,
    isRetryable: isRetryableSignalError,
    logMessage: 'Signal transport failed; retrying',
  });
}

function queueSignalOutboundDelivery<T>(
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = signalOutboundQueues.get(target) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(run);
  const sentinel = task.then(
    () => undefined,
    () => undefined,
  );
  signalOutboundQueues.set(target, sentinel);
  void sentinel.finally(() => {
    if (signalOutboundQueues.get(target) === sentinel) {
      signalOutboundQueues.delete(target);
    }
  });
  return task;
}

export function prepareSignalTextChunks(text: string): string[] {
  const formatted = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const chunks = chunkMessage(formatted, {
    maxChars: resolveTextChunkLimit(),
    maxLines: 200,
  }).filter((chunk) => chunk.trim().length > 0);
  return chunks.length > 0 ? chunks : ['(no content)'];
}

interface SignalSendRpcParams {
  account: string;
  message: string;
  recipient?: string[];
  groupId?: string[];
}

function stripSignalGroupPrefix(recipient: string): string {
  return recipient.replace(/^group:/i, '');
}

function buildSendParams(params: {
  account: string;
  text: string;
  recipientKind: 'phone' | 'uuid' | 'group';
  recipient: string;
}): SignalSendRpcParams {
  const base: SignalSendRpcParams = {
    account: params.account,
    message: params.text,
  };
  if (params.recipientKind === 'group') {
    const groupId = stripSignalGroupPrefix(params.recipient);
    return { ...base, groupId: [groupId] };
  }
  return { ...base, recipient: [params.recipient] };
}

export async function sendSignalTyping(params: {
  daemonUrl: string;
  account: string;
  target: string;
  stop?: boolean;
}): Promise<boolean> {
  const target = parseSignalTarget(params.target);
  if (!target) return false;
  const rpcParams: Record<string, unknown> = {
    account: params.account,
  };
  if (params.stop) {
    rpcParams.stop = true;
  }
  if (target.kind === 'group') {
    rpcParams.groupId = [stripSignalGroupPrefix(target.recipient)];
  } else {
    rpcParams.recipient = [target.recipient];
  }
  await withSignalTransportRetry(
    'signal.sendTyping',
    () => callSignalRpc(params.daemonUrl, 'sendTyping', rpcParams),
    { maxAttempts: 1 },
  );
  return true;
}

export async function sendChunkedSignalText(params: {
  daemonUrl: string;
  account: string;
  target: string;
  text: string;
}): Promise<SignalOutboundMessageRef[]> {
  const target = parseSignalTarget(params.target);
  if (!target) {
    throw new Error(`Invalid Signal target: ${params.target}`);
  }
  return await queueSignalOutboundDelivery(
    `signal:${target.recipient}`,
    async () => {
      const chunks = prepareSignalTextChunks(params.text);
      const outboundDelayMs = resolveOutboundDelayMs();
      const refs: SignalOutboundMessageRef[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const sendParams = buildSendParams({
          account: params.account,
          text: chunks[index],
          recipientKind: target.kind,
          recipient: target.recipient,
        });
        const result = await withSignalTransportRetry(
          'signal.sendChunkedText',
          () =>
            callSignalRpc<{ timestamp?: number }>(
              params.daemonUrl,
              'send',
              sendParams,
            ),
        );
        refs.push({
          recipient: target.recipient,
          timestamp: Number(result?.timestamp || Date.now()),
        });
        if (index < chunks.length - 1) {
          await sleep(outboundDelayMs);
        }
      }
      return refs;
    },
  );
}
