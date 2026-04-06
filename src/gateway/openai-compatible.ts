import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { logger } from '../logger.js';
import { memoryService } from '../memory/memory-service.js';
import { buildSessionKey } from '../session/session-key.js';
import {
  hasMessageSendToolExecution,
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
  normalizeSilentMessageSendReply,
} from './chat-result.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import { getGatewayAdminModels } from './gateway-service.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import {
  OpenAICompatibleRequestError,
  readOpenAICompatibleChatRequest,
} from './openai-compatible-request.js';
import {
  buildOpenAICompatibleCompletionResponse,
  buildOpenAICompatibleModelsResponse,
  buildOpenAICompatibleStreamRoleChunk,
  buildOpenAICompatibleStreamStopChunk,
  buildOpenAICompatibleStreamTextChunk,
  buildOpenAICompatibleStreamUsageChunk,
  sendOpenAICompatibleStreamError,
  writeOpenAICompatibleStreamChunk,
} from './openai-compatible-response.js';

function isResponseWritable(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed;
}

function normalizeGatewayResult(result: GatewayChatResult): GatewayChatResult {
  return normalizePendingApprovalReply(
    normalizePlaceholderToolReply(normalizeSilentMessageSendReply(result)),
  );
}

function buildGatewayChatRequest(
  input: Awaited<ReturnType<typeof readOpenAICompatibleChatRequest>>,
): GatewayChatRequest {
  const sessionId = buildSessionKey(
    DEFAULT_AGENT_ID,
    'openai',
    'dm',
    randomUUID().replace(/-/g, '').slice(0, 16),
  );

  memoryService.getOrCreateSession(sessionId, null, 'openai', DEFAULT_AGENT_ID);
  for (const message of input.priorMessages) {
    memoryService.storeMessage({
      sessionId,
      userId: sessionId,
      username: input.user,
      role: message.role,
      content: message.content,
    });
  }

  return {
    sessionId,
    guildId: null,
    channelId: 'openai',
    userId: sessionId,
    username: input.user,
    content: input.prompt,
    ...(input.media.length > 0 ? { media: input.media } : {}),
    model: input.model,
    source: 'gateway.chat.openai-compatible',
  };
}

function toRequestError(error: unknown): OpenAICompatibleRequestError {
  if (error instanceof OpenAICompatibleRequestError) return error;
  return new OpenAICompatibleRequestError(
    500,
    error instanceof Error ? error.message : String(error),
    { type: 'server_error' },
  );
}

function assertGatewaySuccess(
  result: GatewayChatResult,
): asserts result is GatewayChatResult & { status: 'success' } {
  if (result.status === 'success') return;
  throw new OpenAICompatibleRequestError(
    500,
    result.error || 'OpenAI-compatible chat completion failed.',
    { type: 'server_error' },
  );
}

async function runOpenAICompatibleChat(
  chatRequest: GatewayChatRequest,
): Promise<GatewayChatResult & { status: 'success' }> {
  const result = normalizeGatewayResult(
    await handleGatewayMessage(chatRequest),
  );
  assertGatewaySuccess(result);
  return result;
}

export async function handleOpenAICompatibleModelList(
  res: ServerResponse,
): Promise<void> {
  const models = await getGatewayAdminModels();
  const payload = buildOpenAICompatibleModelsResponse(
    models.models.map((model) => model.id),
  );
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function handleOpenAICompatibleNonStreamingChat(
  res: ServerResponse,
  chatRequest: GatewayChatRequest,
  completionId: string,
  created: number,
): Promise<void> {
  const result = await runOpenAICompatibleChat(chatRequest);
  const payload = buildOpenAICompatibleCompletionResponse({
    completionId,
    created,
    model: chatRequest.model || '',
    content: typeof result.result === 'string' ? result.result : '',
    tokenUsage: result.tokenUsage,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function handleOpenAICompatibleStreamingChat(
  req: IncomingMessage,
  res: ServerResponse,
  chatRequest: GatewayChatRequest,
  includeUsage: boolean,
  completionId: string,
  created: number,
): Promise<void> {
  const abortController = new AbortController();
  const abortStreaming = (): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error('Client disconnected.'));
    }
  };
  req.on('close', abortStreaming);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (!isResponseWritable(res)) {
    abortStreaming();
    req.off('close', abortStreaming);
    return;
  }

  writeOpenAICompatibleStreamChunk(
    res,
    buildOpenAICompatibleStreamRoleChunk({
      completionId,
      created,
      model: chatRequest.model || '',
    }),
  );

  const streamFilter = createSilentReplyStreamFilter();
  let emittedText = '';
  try {
    const result = await runOpenAICompatibleChat({
      ...chatRequest,
      abortSignal: abortController.signal,
      onTextDelta: (delta: string) => {
        const filtered = streamFilter.push(delta);
        if (!filtered) return;
        if (!isResponseWritable(res)) {
          abortStreaming();
          return;
        }
        emittedText += filtered;
        writeOpenAICompatibleStreamChunk(
          res,
          buildOpenAICompatibleStreamTextChunk({
            completionId,
            created,
            model: chatRequest.model || '',
            content: filtered,
          }),
        );
      },
    });

    if (!isResponseWritable(res)) return;

    const buffered = streamFilter.flush();
    if (buffered) {
      emittedText += buffered;
      writeOpenAICompatibleStreamChunk(
        res,
        buildOpenAICompatibleStreamTextChunk({
          completionId,
          created,
          model: chatRequest.model || '',
          content: buffered,
        }),
      );
    }

    if (streamFilter.isSilent() && hasMessageSendToolExecution(result)) {
      result.result = 'Message sent.';
    }

    const finalText = typeof result.result === 'string' ? result.result : '';
    if (!emittedText && finalText) {
      writeOpenAICompatibleStreamChunk(
        res,
        buildOpenAICompatibleStreamTextChunk({
          completionId,
          created,
          model: chatRequest.model || '',
          content: finalText,
        }),
      );
    }

    writeOpenAICompatibleStreamChunk(
      res,
      buildOpenAICompatibleStreamStopChunk({
        completionId,
        created,
        model: chatRequest.model || '',
      }),
    );

    if (includeUsage) {
      writeOpenAICompatibleStreamChunk(
        res,
        buildOpenAICompatibleStreamUsageChunk({
          completionId,
          created,
          model: chatRequest.model || '',
          tokenUsage: result.tokenUsage,
        }),
      );
    }

    writeOpenAICompatibleStreamChunk(res, '[DONE]');
    res.end();
  } finally {
    req.off('close', abortStreaming);
  }
}

export async function handleOpenAICompatibleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const input = await readOpenAICompatibleChatRequest(req);
    const chatRequest = buildGatewayChatRequest(input);
    const completionId = `chatcmpl_${randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);

    if (input.wantsStream) {
      await handleOpenAICompatibleStreamingChat(
        req,
        res,
        chatRequest,
        input.includeUsage,
        completionId,
        created,
      );
      return;
    }

    await handleOpenAICompatibleNonStreamingChat(
      res,
      chatRequest,
      completionId,
      created,
    );
  } catch (error) {
    const typed = toRequestError(error);
    if (!isResponseWritable(res)) return;
    logger.error({ error }, 'OpenAI-compatible chat completion failed');
    sendOpenAICompatibleStreamError(res, typed.statusCode, typed.message, {
      type: typed.type,
      param: typed.param,
      code: typed.code,
    });
  }
}
