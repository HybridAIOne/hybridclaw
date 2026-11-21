/**
 * Native Responses transport shared by API-key and Codex authentication.
 * Keeps opaque reasoning items with tool calls for replay; unlike Chat
 * Completions adapters, it never folds provider state into visible text.
 */
import {
  adaptResponsesPayload,
  buildResponsesRequestBody,
  buildResponsesStreamResponse,
  consumeResponsesStreamEvent,
  createResponsesStreamState,
  normalizeCodexModelName,
  responsesContentText,
} from '@hybridclaw/shared/provider-wire/codex-responses';
import {
  drainServerSentEventBlocks,
  parseServerSentEventBlock,
} from '@hybridclaw/shared/server-sent-events';
import type { ChatCompletionResponse } from '../types.js';
import {
  buildRequestHeaders,
  emitRawSsePayloadDebug,
  logLastPrompt,
  logModelResponseDebug,
  type NormalizedCallArgs,
  type NormalizedStreamCallArgs,
  ProviderRequestError,
  readRetryAfterMs,
} from './shared.js';
import {
  emitResponseTextDeltas,
  fetchWithHeaderTimeout,
  readJsonWithIdleTimeout,
  readWithIdleTimeout,
  STREAM_IDLE_TIMEOUT_MS,
} from './stream-utils.js';

function providerTransportLabel(
  provider: NormalizedCallArgs['provider'],
): 'codex' | 'openai' {
  return provider === 'openai' ? 'openai' : 'codex';
}

function logCodexTransport(
  provider: NormalizedCallArgs['provider'],
  message: string,
): void {
  console.error(`[${providerTransportLabel(provider)}] ${message}`);
}

function isCodexEmptyVisibleCompletion(
  response: ChatCompletionResponse,
): boolean {
  const choice = response.choices[0];
  if (!choice) return true;
  if ((choice.message.tool_calls || []).length > 0) return false;
  return !responsesContentText(choice.message.content);
}

function assertNonEmptyCodexResponse(
  response: ChatCompletionResponse,
  fallbackModel: string,
  provider: NormalizedCallArgs['provider'],
): void {
  if (!isCodexEmptyVisibleCompletion(response)) return;
  const choice = response.choices[0];
  const content = choice?.message?.content ?? null;
  const contentType = Array.isArray(content)
    ? 'parts'
    : content === null
      ? 'null'
      : typeof content;
  logCodexTransport(
    provider,
    `empty completion model=${normalizeCodexModelName(fallbackModel)} responseModel=${response.model || '<missing>'} finish=${choice?.finish_reason || '<missing>'} contentType=${contentType}`,
  );
  const label = provider === 'openai' ? 'OpenAI' : 'Codex';
  throw new Error(`${label} Responses API returned no output items`);
}

export async function callOpenAICodexProvider(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  // The Codex backend currently requires `stream: true` even for callers that
  // want a single final response body. Use the streaming transport internally
  // and suppress text-delta callbacks for the non-streaming runtime path.
  return callOpenAIResponsesProviderStreamInternal({
    ...args,
    onTextDelta: () => undefined,
  });
}

export async function callOpenAICodexProviderStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  return callOpenAIResponsesProviderStreamInternal(args);
}

export async function callOpenAIResponsesProvider(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  return callOpenAIResponsesProviderStreamInternal({
    ...args,
    onTextDelta: () => undefined,
  });
}

export async function callOpenAIResponsesProviderStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  return callOpenAIResponsesProviderStreamInternal(args);
}

async function callOpenAIResponsesProviderStreamInternal(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  const startedAt = Date.now();
  logCodexTransport(
    args.provider,
    `stream request start model=${normalizeCodexModelName(args.model)} messages=${args.messages.length} tools=${args.tools.length}`,
  );
  const body = {
    ...buildResponsesRequestBody({
      provider: args.provider,
      model: args.model,
      messages: args.messages,
      tools: args.tools,
      promptCacheKey: args.sessionId,
      maxTokens: args.maxTokens,
    }),
    stream: true,
  };
  if (args.debugModelResponses) {
    logLastPrompt({
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model,
      kind: 'openai_codex_streaming_request',
      request: {
        method: 'POST',
        url: `${args.baseUrl}/responses`,
        body,
      },
    });
  }
  const response = await fetchWithHeaderTimeout((signal) =>
    fetch(`${args.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        ...buildRequestHeaders(args.apiKey, args.requestHeaders),
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(body),
      signal,
    }),
  );
  logCodexTransport(
    args.provider,
    `stream response headers model=${normalizeCodexModelName(args.model)} status=${response.status} durationMs=${Date.now() - startedAt} contentType=${response.headers.get('content-type') || '<missing>'}`,
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
      !contentType.includes('event-stream')) ||
    !response.body
  ) {
    const payload = await readJsonWithIdleTimeout(response);
    if (args.debugModelResponses) {
      logModelResponseDebug({
        provider: args.provider,
        model: args.model,
        kind: 'raw_non_streaming_response',
        response: payload,
      });
    }
    const adapted = adaptResponsesPayload<ChatCompletionResponse['usage']>(
      payload,
      args.model,
    );
    assertNonEmptyCodexResponse(adapted, args.model, args.provider);
    emitResponseTextDeltas(adapted, args.onTextDelta);
    return adapted;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const streamState = createResponsesStreamState(args.model);
  const handlers = {
    onTextDelta: args.onTextDelta,
    onActivity: args.onActivity,
  };
  let buffer = '';
  let sawPayload = false;
  let streamDone = false;
  let firstEventMs: number | null = null;

  try {
    while (!streamDone) {
      const { done, value } = await readWithIdleTimeout(
        reader,
        STREAM_IDLE_TIMEOUT_MS,
      );
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const drained = drainServerSentEventBlocks(buffer);
      buffer = drained.remainder;

      for (const block of drained.blocks) {
        const event = parseServerSentEventBlock(block);
        if (!event) continue;
        emitRawSsePayloadDebug(args, event.data);
        sawPayload = true;
        if (firstEventMs == null) {
          firstEventMs = Date.now() - startedAt;
          logCodexTransport(
            args.provider,
            `stream first event model=${normalizeCodexModelName(args.model)} durationMs=${firstEventMs} event=${event.event || '<default>'}`,
          );
        }
        streamDone = consumeResponsesStreamEvent(
          event.data,
          event.event,
          streamState,
          handlers,
        );
        if (streamDone) break;
      }
    }

    if (!streamDone && buffer.trim()) {
      const event = parseServerSentEventBlock(buffer);
      if (event) {
        emitRawSsePayloadDebug(args, event.data);
        sawPayload = true;
        if (firstEventMs == null) {
          firstEventMs = Date.now() - startedAt;
          logCodexTransport(
            args.provider,
            `stream first event model=${normalizeCodexModelName(args.model)} durationMs=${firstEventMs} event=${event.event || '<default>'}`,
          );
        }
        streamDone = consumeResponsesStreamEvent(
          event.data,
          event.event,
          streamState,
          handlers,
        );
      }
    }
  } finally {
    reader.releaseLock();
    decoder.decode();
  }

  if (!sawPayload) {
    const label = args.provider === 'openai' ? 'OpenAI' : 'Codex';
    throw new Error(`${label} streaming response ended without payload`);
  }

  logCodexTransport(
    args.provider,
    `stream complete model=${normalizeCodexModelName(args.model)} durationMs=${Date.now() - startedAt}`,
  );
  const adapted = buildResponsesStreamResponse<ChatCompletionResponse['usage']>(
    streamState,
    args.model,
  );
  assertNonEmptyCodexResponse(adapted, args.model, args.provider);
  return adapted;
}
