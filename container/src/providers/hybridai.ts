/**
 * HybridAI streams succeed only after an explicit completion signal.
 * Unlike transport EOF, a terminal marker establishes completion; provider
 * error events reject the call even after visible deltas were delivered.
 */
import { fetchHybridAIDestination } from '@hybridclaw/shared/hybridai-destination';
import { isRecord } from '@hybridclaw/shared/primitive-values';
import {
  applyChatCompletionsChunk,
  createChatCompletionsStreamState,
} from '@hybridclaw/shared/provider-wire/chat-completions';
import { buildHybridAIRequestBody } from '@hybridclaw/shared/provider-wire/hybridai-body';
import { stripHybridAIModelPrefix } from '@hybridclaw/shared/provider-wire/model-names';
import { readServerSentEvents } from '@hybridclaw/shared/provider-wire/server-sent-events';
import type { ChatCompletionResponse } from '../types.js';
import { HYBRIDCLAW_USER_AGENT } from '../user-agent.js';
import {
  buildRequestHeaders,
  emitRawNdjsonLineDebug,
  emitRawSsePayloadDebug,
  logLastPrompt,
  logModelResponseDebug,
  type NormalizedCallArgs,
  type NormalizedStreamCallArgs,
  ProviderRequestError,
  readRetryAfterMs,
} from './shared.js';
import {
  fetchWithHeaderTimeout,
  readJsonWithIdleTimeout,
  readWithIdleTimeout,
  STREAM_IDLE_TIMEOUT_MS,
} from './stream-utils.js';

function buildRequestBody(args: NormalizedCallArgs): Record<string, unknown> {
  return buildHybridAIRequestBody({
    model: args.model,
    messages: args.messages,
    chatbotId: args.chatbotId,
    enableRag: args.enableRag,
    tools: args.tools,
    maxTokens: args.maxTokens,
    reasoningEffort: args.reasoningEffort,
    adaptiveThinking: args.modelBehavior?.adaptiveThinking === true,
  });
}

function buildHybridAIRequestHeaders(
  args: NormalizedCallArgs,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    ...buildRequestHeaders(args.apiKey, {
      'User-Agent': HYBRIDCLAW_USER_AGENT,
      ...(args.requestHeaders || {}),
    }),
    ...(extraHeaders || {}),
  };
}

async function* readStreamPayloads(
  read: () => Promise<{ done: boolean; value?: Uint8Array }>,
  ndjson: boolean,
): AsyncGenerator<string> {
  if (!ndjson) {
    for await (const event of readServerSentEvents(read)) yield event.data;
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    yield* lines;
    if (done) break;
  }
  yield buffer;
}

export async function callHybridAIProvider(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  const body = buildRequestBody(args);
  if (args.debugModelResponses) {
    logLastPrompt({
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model,
      kind: 'hybridai_non_streaming_request',
      request: {
        method: 'POST',
        url: `${args.baseUrl}/v1/chat/completions`,
        body,
      },
    });
  }
  const response = await fetchHybridAIDestination(
    `${args.baseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: buildHybridAIRequestHeaders(args),
      body: JSON.stringify(body),
    },
    args.requestHeaders,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderRequestError(
      response.status,
      text,
      readRetryAfterMs(response.headers),
    );
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  if (args.debugModelResponses) {
    logModelResponseDebug({
      provider: args.provider,
      model: args.model,
      kind: 'raw_non_streaming_response',
      response: payload,
    });
  }
  return payload;
}

export async function callHybridAIProviderStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  const body = {
    ...buildRequestBody(args),
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };
  if (args.debugModelResponses) {
    logLastPrompt({
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model,
      kind: 'hybridai_streaming_request',
      request: {
        method: 'POST',
        url: `${args.baseUrl}/v1/chat/completions`,
        body,
      },
    });
  }

  const response = await fetchWithHeaderTimeout((signal) =>
    fetchHybridAIDestination(
      `${args.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: buildHybridAIRequestHeaders(args, {
          Accept: 'text/event-stream, application/x-ndjson, application/json',
        }),
        body: JSON.stringify(body),
        signal,
      },
      args.requestHeaders,
    ),
  );

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderRequestError(
      response.status,
      text,
      readRetryAfterMs(response.headers),
    );
  }

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    (contentType.includes('application/json') &&
      !contentType.includes('ndjson') &&
      !contentType.includes('event-stream')) ||
    !response.body
  ) {
    const payload = (await readJsonWithIdleTimeout(
      response,
    )) as ChatCompletionResponse;
    if (args.debugModelResponses) {
      logModelResponseDebug({
        provider: args.provider,
        model: args.model,
        kind: 'raw_non_streaming_response',
        response: payload,
      });
    }
    return payload;
  }

  const reader = response.body.getReader();
  const ndjson = contentType.includes('ndjson');
  const state = createChatCompletionsStreamState<
    ChatCompletionResponse['usage']
  >(stripHybridAIModelPrefix(args.model));
  let sawPayload = false;
  let streamDone = false;

  const consumePayload = (payloadText: string): void => {
    if (payloadText === '[DONE]') {
      streamDone = true;
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText) as unknown;
    } catch {
      return;
    }
    if (!isRecord(payload)) return;
    if (payload.error != null) {
      throw new Error('HybridAI stream reported a provider error');
    }
    args.onActivity?.();
    sawPayload = true;
    const added = applyChatCompletionsChunk(state, payload);
    if (added.content) args.onTextDelta(added.content);
    if (added.reasoning) args.onThinkingDelta?.(added.reasoning);
  };

  try {
    for await (const raw of readStreamPayloads(
      () => readWithIdleTimeout(reader, STREAM_IDLE_TIMEOUT_MS),
      ndjson,
    )) {
      const payloadText = raw.trim();
      if (!payloadText) continue;
      if (ndjson) emitRawNdjsonLineDebug(args, payloadText);
      else emitRawSsePayloadDebug(args, payloadText);
      consumePayload(payloadText);
      if (streamDone) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (!streamDone && !state.finishReason)
    throw new Error('HybridAI stream ended without a completion marker');

  if (!sawPayload) {
    throw new Error('Streaming response ended without payload');
  }

  return {
    id: state.id || 'stream',
    model: state.model,
    choices: [
      {
        message: {
          role: state.role,
          content: state.content || null,
          ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
          ...(state.anthropicContent.length > 0
            ? { anthropic_content: state.anthropicContent }
            : {}),
          ...(state.toolCalls.length > 0
            ? { tool_calls: state.toolCalls }
            : {}),
        },
        finish_reason:
          state.finishReason ||
          (state.toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      },
    ],
    ...(state.usage ? { usage: state.usage } : {}),
  };
}
