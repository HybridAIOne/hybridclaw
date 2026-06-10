import type { AgentConfig, AgentProxyConfig } from '../agents/agent-types.js';
import { makeAuditRunId } from '../audit/audit-events.js';
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
  url: string;
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
        host: new URL(params.url).host,
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(
        new ProxyAgentError('HybridAI proxy stream timed out.', {
          code: 'network',
          status: 0,
        }),
      );
    }, HYBRIDAI_PROXY_STREAM_IDLE_TIMEOUT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
      reject(
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
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function extractOpenAIChoiceText(payload: Record<string, unknown>): string {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!isRecord(choice)) return '';
  const delta = isRecord(choice.delta) ? choice.delta : null;
  if (typeof delta?.content === 'string') return delta.content;
  const message = isRecord(choice.message) ? choice.message : null;
  if (typeof message?.content === 'string') return message.content;
  return '';
}

function readStringField(
  payload: Record<string, unknown>,
  fields: string[],
): string {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === 'string') return value;
  }
  return '';
}

function extractResponseText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!isRecord(payload)) return '';
  const direct = readStringField(payload, [
    'text',
    'message',
    'answer',
    'response',
    'result',
    'content',
  ]);
  if (direct) return direct;
  const data = payload.data;
  if (isRecord(data)) return extractResponseText(data);
  return extractOpenAIChoiceText(payload);
}

function extractStreamDelta(params: {
  payload: unknown;
  currentText: string;
}): string {
  if (typeof params.payload === 'string') return params.payload;
  if (!isRecord(params.payload)) return '';

  const explicitDelta = readStringField(params.payload, ['delta', 'chunk']);
  if (explicitDelta) return explicitDelta;

  const openAIText = extractOpenAIChoiceText(params.payload);
  if (openAIText) return openAIText;

  const fullText = readStringField(params.payload, [
    'text',
    'message',
    'answer',
    'response',
    'result',
    'content',
  ]);
  if (!fullText) {
    const data = params.payload.data;
    return isRecord(data)
      ? extractStreamDelta({ payload: data, currentText: params.currentText })
      : '';
  }
  return fullText.startsWith(params.currentText)
    ? fullText.slice(params.currentText.length)
    : fullText;
}

function parseStreamPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
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

function parseDelimitedStreamPayloads(buffer: string): {
  payloads: string[];
  remaining: string;
} {
  if (buffer.includes('\n\n') || buffer.includes('\r\n\r\n')) {
    const blocks = buffer.split(/\r?\n\r?\n/);
    return {
      payloads: blocks.slice(0, -1).flatMap(parseSseBlock),
      remaining: blocks.at(-1) || '',
    };
  }

  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() || '';
  return {
    payloads: lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith('data:') ? line.slice(5).trim() : line)),
    remaining,
  };
}

async function readStreamingResponse(params: {
  response: Response;
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
}): Promise<string> {
  if (!params.response.body) {
    return extractResponseText(await params.response.json().catch(() => null));
  }

  const reader = params.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resultText = '';
  try {
    while (true) {
      const next = await readWithIdleTimeout(reader, params.signal);
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const parsed = parseDelimitedStreamPayloads(buffer);
      buffer = parsed.remaining;
      for (const payloadText of parsed.payloads) {
        if (!payloadText || payloadText === '[DONE]') continue;
        const delta = extractStreamDelta({
          payload: parseStreamPayload(payloadText),
          currentText: resultText,
        });
        if (!delta) continue;
        resultText += delta;
        params.onTextDelta?.(delta);
      }
    }
    if (buffer.trim() && buffer.trim() !== '[DONE]') {
      const delta = extractStreamDelta({
        payload: parseStreamPayload(buffer),
        currentText: resultText,
      });
      if (delta) {
        resultText += delta;
        params.onTextDelta?.(delta);
      }
    }
  } finally {
    reader.releaseLock();
    decoder.decode();
  }
  return resultText;
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
    !contentType.includes('event-stream') &&
    !contentType.includes('ndjson')
  ) {
    const text = extractResponseText(await params.response.json());
    if (text) params.onTextDelta?.(text);
    return text;
  }
  return readStreamingResponse(params);
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
  url: string;
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
      upstreamHost: new URL(params.url).host,
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
  agent: AgentConfig;
  runId?: string;
  abortSignal?: AbortSignal;
}): Promise<GatewayChatResult> {
  const proxy = params.agent.proxy;
  if (!proxy) {
    throw new Error(
      `Agent "${params.agent.id}" is not configured for proxying.`,
    );
  }
  const runId = params.runId || makeAuditRunId('proxy-agent');
  const url = resolveProxyUrl(proxy);

  try {
    const apiKey = resolveProxyApiKey({
      proxy,
      agentId: params.agent.id,
      sessionId: params.req.sessionId,
      runId,
      url,
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
          Accept: 'text/event-stream, application/x-ndjson, application/json',
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
      url,
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
