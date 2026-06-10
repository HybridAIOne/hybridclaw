import type { AgentConfig, AgentProxyConfig } from '../agents/agent-types.js';
import { logger } from '../logger.js';
import { resolveSecretInputUnsafe } from '../security/secret-refs.js';
import { isRecord } from '../utils/type-guards.js';
import { recordSecretUnsafeEscaped } from './gateway-secret-injection.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';

const HYBRIDAI_PROXY_CHAT_PATH = '/api/v1/gateway/chat';
const HYBRIDAI_PROXY_CONNECT_TIMEOUT_MS = 30_000;
const HYBRIDAI_PROXY_STREAM_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_PROXY_ERROR_REPLY =
  'The bot is not reachable right now. Please try again later.';
const PROXY_CONFIG_ERROR_REPLY =
  'The bot is not reachable because its upstream configuration needs attention.';
const PROXY_RATE_LIMIT_REPLY =
  'The bot is receiving too many requests right now. Please try again shortly.';

class ProxyAgentError extends Error {
  status: number;
  code: 'config' | 'rate_limit' | 'upstream' | 'network';

  constructor(
    message: string,
    options: {
      status?: number;
      code?: ProxyAgentError['code'];
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ProxyAgentError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 'upstream';
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, '');
}

function resolveProxyUrl(proxy: AgentProxyConfig): string {
  return `${normalizeBaseUrl(proxy.baseUrl)}${HYBRIDAI_PROXY_CHAT_PATH}`;
}

function normalizeExternalUserNamespace(source: string | undefined): string {
  const normalized = String(source || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'gateway';
}

function buildExternalUserId(req: GatewayChatRequest): string {
  const namespace = normalizeExternalUserNamespace(req.source);
  const userId = String(req.userId || '').trim() || 'unknown';
  return `${namespace}:${userId}`;
}

function buildConversationId(params: {
  proxy: AgentProxyConfig;
  req: GatewayChatRequest;
  externalUserId: string;
}): string {
  const sessionId = String(params.req.sessionId || '').trim();
  if (params.proxy.conversationScope === 'user') {
    return `${sessionId}:${params.externalUserId}`;
  }
  return sessionId;
}

function resolveProxyApiKey(params: {
  proxy: AgentProxyConfig;
  agentId: string;
  sessionId: string;
  runId: string;
  upstreamHost: string;
}): string {
  const secret = resolveSecretInputUnsafe(params.proxy.apiKey, {
    path: `agents.${params.agentId}.proxy.apiKey`,
    required: true,
    reason: 'inject HybridAI proxy API key into Authorization header',
    audit: (handle, reason) =>
      recordSecretUnsafeEscaped({
        sessionId: params.sessionId,
        runId: params.runId,
        skillName: 'gateway.proxy_agent',
        secretSource: handle.ref.source,
        secretId: handle.ref.id,
        sinkKind: 'http',
        host: params.upstreamHost,
        selector: 'Authorization',
        reason,
      }),
  });
  if (!secret) {
    throw new ProxyAgentError('HybridAI proxy API key is not configured.', {
      code: 'config',
      status: 0,
    });
  }
  return secret;
}

function createForwardedSignal(externalSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  clearConnectTimeout: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('HybridAI proxy connection timed out.'));
  }, HYBRIDAI_PROXY_CONNECT_TIMEOUT_MS);
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    externalSignal.addEventListener('abort', onAbort, { once: true });
    if (externalSignal.aborted) onAbort();
  }
  return {
    signal: controller.signal,
    clearConnectTimeout: () => clearTimeout(timeout),
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    reader.cancel().catch(() => {});
    return Promise.reject(
      new ProxyAgentError('HybridAI proxy request was aborted.', {
        code: 'network',
        status: 0,
        cause: signal.reason,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      fail(
        new ProxyAgentError('HybridAI proxy stream timed out.', {
          code: 'network',
          status: 0,
        }),
      );
    }, HYBRIDAI_PROXY_STREAM_IDLE_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reader.cancel().catch(() => {});
      reject(error);
    };
    const onAbort = () => {
      fail(
        new ProxyAgentError('HybridAI proxy request was aborted.', {
          code: 'network',
          status: 0,
          cause: signal.reason,
        }),
      );
    };

    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        fail(error);
      },
    );
  });
}

function parseHybridAIStreamPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function parseSseBlock(block: string): string[] {
  const lines = block.split(/\r?\n/);
  const dataLines = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  return dataLines.length > 0 ? [dataLines.join('\n').trim()] : [];
}

function parseHybridAISsePayloads(buffer: string): {
  payloads: string[];
  remaining: string;
} {
  const blocks = buffer.split(/\r?\n\r?\n/);
  return {
    payloads: blocks.slice(0, -1).flatMap(parseSseBlock),
    remaining: blocks.at(-1) || '',
  };
}

function extractHybridAIStreamDelta(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const delta = payload.delta;
  return typeof delta === 'string' ? delta : '';
}

function extractHybridAIJsonText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const text = payload.text;
  return typeof text === 'string' ? text : '';
}

async function readHybridAISseResponse(params: {
  response: Response;
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
}): Promise<string> {
  if (!params.response.body) {
    return '';
  }

  const reader = params.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const resultParts: string[] = [];
  try {
    while (true) {
      const next = await readWithIdleTimeout(reader, params.signal);
      if (next.done) break;
      const parsed = parseHybridAISsePayloads(
        [buffer, decoder.decode(next.value, { stream: true })].join(''),
      );
      buffer = parsed.remaining;
      for (const payloadText of parsed.payloads) {
        if (!payloadText || payloadText === '[DONE]') continue;
        const delta = extractHybridAIStreamDelta(
          parseHybridAIStreamPayload(payloadText),
        );
        if (!delta) continue;
        resultParts.push(delta);
        params.onTextDelta?.(delta);
      }
    }
    if (buffer.trim() && buffer.trim() !== '[DONE]') {
      const delta = extractHybridAIStreamDelta(
        parseHybridAIStreamPayload(parseSseBlock(buffer)[0] || buffer),
      );
      if (delta) {
        resultParts.push(delta);
        params.onTextDelta?.(delta);
      }
    }
  } finally {
    reader.releaseLock();
    decoder.decode();
  }
  return resultParts.join('');
}

async function readHybridAIProxyResponse(params: {
  response: Response;
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
}): Promise<string> {
  const contentType = (
    params.response.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    contentType.includes('application/json') &&
    !contentType.includes('event-stream')
  ) {
    const text = extractHybridAIJsonText(await params.response.json());
    if (text) params.onTextDelta?.(text);
    return text;
  }
  return readHybridAISseResponse(params);
}

function mapProxyErrorToReply(error: unknown): string {
  if (error instanceof ProxyAgentError) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.code === 'config'
    ) {
      return PROXY_CONFIG_ERROR_REPLY;
    }
    if (error.status === 429 || error.code === 'rate_limit') {
      return PROXY_RATE_LIMIT_REPLY;
    }
  }
  return DEFAULT_PROXY_ERROR_REPLY;
}

function logProxyFailure(params: {
  agentId: string;
  sessionId: string;
  channelId: string;
  upstreamHost: string;
  error: unknown;
}): void {
  const status =
    params.error instanceof ProxyAgentError ? params.error.status : 0;
  const code = params.error instanceof ProxyAgentError ? params.error.code : '';
  logger.warn(
    {
      agentId: params.agentId,
      sessionId: params.sessionId,
      channelId: params.channelId,
      upstreamHost: params.upstreamHost,
      status,
      code,
      error:
        params.error instanceof Error
          ? params.error.message
          : String(params.error),
    },
    'HybridAI proxy agent request failed',
  );
}

export async function forwardGatewayMessageToProxyAgent(params: {
  req: GatewayChatRequest;
  agent: AgentConfig & { proxy: AgentProxyConfig };
  runId: string;
  abortSignal?: AbortSignal;
}): Promise<GatewayChatResult> {
  const proxy = params.agent.proxy;
  const url = resolveProxyUrl(proxy);
  const upstreamHost = new URL(url).host;

  try {
    const apiKey = resolveProxyApiKey({
      proxy,
      agentId: params.agent.id,
      sessionId: params.req.sessionId,
      runId: params.runId,
      upstreamHost,
    });
    const externalUserId = buildExternalUserId(params.req);
    const body = {
      chatbot_id: proxy.chatbotId,
      message: params.req.content,
      external_user_id: externalUserId,
      conversation_id: buildConversationId({
        proxy,
        req: params.req,
        externalUserId,
      }),
      username: params.req.username || undefined,
      stream: true,
    };
    const forwardedSignal = createForwardedSignal(params.abortSignal);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream, application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: forwardedSignal.signal,
      });
      forwardedSignal.clearConnectTimeout();
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProxyAgentError(
          `HybridAI proxy returned HTTP ${response.status}.`,
          {
            status: response.status,
            code: response.status === 429 ? 'rate_limit' : 'upstream',
          },
        );
      }
      const resultText =
        (await readHybridAIProxyResponse({
          response,
          signal: forwardedSignal.signal,
          onTextDelta: params.req.onTextDelta,
        })) || DEFAULT_PROXY_ERROR_REPLY;
      return {
        status: 'success',
        result: resultText,
        messageRole: 'assistant',
        toolsUsed: [],
        agentId: params.agent.id,
        provider: 'hybridai-proxy',
      };
    } catch (error) {
      if (error instanceof ProxyAgentError) throw error;
      throw new ProxyAgentError('HybridAI proxy request failed.', {
        code: 'network',
        status: 0,
        cause: error,
      });
    } finally {
      forwardedSignal.dispose();
    }
  } catch (error) {
    logProxyFailure({
      agentId: params.agent.id,
      sessionId: params.req.sessionId,
      channelId: params.req.channelId,
      upstreamHost,
      error,
    });
    return {
      status: 'success',
      result: mapProxyErrorToReply(error),
      messageRole: 'assistant',
      toolsUsed: [],
      agentId: params.agent.id,
      provider: 'hybridai-proxy',
    };
  }
}
