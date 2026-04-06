import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { buildConversationContext } from '../agent/conversation.js';
import { stopSessionExecution } from '../agent/executor.js';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { HYBRIDAI_MODEL } from '../config/config.js';
import { parseEvalProfileModel } from '../evals/eval-profile.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { memoryService } from '../memory/memory-service.js';
import {
  modelRequiresChatbotId,
  resolveModelRuntimeCredentials,
} from '../providers/factory.js';
import { buildSessionContext } from '../session/session-context.js';
import { buildSessionKey } from '../session/session-key.js';
import type { ChatMessage } from '../types/api.js';
import { ensureBootstrapFiles, resetWorkspace } from '../workspace.js';
import {
  hasMessageSendToolExecution,
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
  normalizeSilentMessageSendReply,
} from './chat-result.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import {
  getGatewayAdminModels,
  readSystemPromptMessage,
  resolveGatewayChatbotId,
} from './gateway-service.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import {
  callOpenAICompatibleModel,
  callOpenAICompatibleModelStream,
  mapOpenAICompatibleUsageToTokenStats,
} from './openai-compatible-model.js';
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
  buildOpenAICompatibleStreamToolCallsChunk,
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

function prepareOpenAICompatibleRequest(
  input: Awaited<ReturnType<typeof readOpenAICompatibleChatRequest>>,
): {
  responseModel: string;
  cleanupAgentId: string | null;
  requestAgentId: string;
  sessionId: string;
  model: string;
  profile: ReturnType<typeof parseEvalProfileModel>['profile'];
} {
  const parsed = (() => {
    try {
      return parseEvalProfileModel(input.model);
    } catch (error) {
      throw new OpenAICompatibleRequestError(
        400,
        error instanceof Error ? error.message : 'Invalid eval model profile.',
        {
          param: 'model',
          code: 'unsupported_value',
        },
      );
    }
  })();
  const { model, profile } = parsed;
  const freshAgentId =
    profile.workspaceMode === 'fresh-agent'
      ? `eval-${randomUUID().replace(/-/g, '').slice(0, 16)}`
      : null;
  const requestAgentId = freshAgentId || profile.agentId || DEFAULT_AGENT_ID;
  const sessionId = buildSessionKey(
    requestAgentId,
    'openai',
    'dm',
    randomUUID().replace(/-/g, '').slice(0, 16),
  );

  memoryService.getOrCreateSession(sessionId, null, 'openai', requestAgentId);
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
    responseModel: input.model,
    cleanupAgentId: freshAgentId,
    requestAgentId,
    sessionId,
    model,
    profile,
  };
}

function buildGatewayChatRequest(params: {
  input: Awaited<ReturnType<typeof readOpenAICompatibleChatRequest>>;
  prepared: ReturnType<typeof prepareOpenAICompatibleRequest>;
}): GatewayChatRequest {
  const includeAgentId =
    Boolean(params.prepared.cleanupAgentId) ||
    Boolean(params.prepared.profile.agentId?.trim());
  return {
    sessionId: params.prepared.sessionId,
    guildId: null,
    channelId: 'openai',
    userId: params.prepared.sessionId,
    username: params.input.user,
    content: params.input.prompt,
    ...(params.input.media.length > 0 ? { media: params.input.media } : {}),
    ...(includeAgentId ? { agentId: params.prepared.requestAgentId } : {}),
    model: params.prepared.model,
    ...(params.prepared.profile.ablateSystemPrompt
      ? { promptMode: 'none' as const }
      : {}),
    ...(!params.prepared.profile.ablateSystemPrompt &&
    params.prepared.profile.includePromptParts.length > 0
      ? { includePromptParts: params.prepared.profile.includePromptParts }
      : {}),
    ...(!params.prepared.profile.ablateSystemPrompt &&
    params.prepared.profile.omitPromptParts.length > 0
      ? { omitPromptParts: params.prepared.profile.omitPromptParts }
      : {}),
    source: 'gateway.chat.openai-compatible',
  };
}

async function buildToolAwareMessages(params: {
  input: Awaited<ReturnType<typeof readOpenAICompatibleChatRequest>>;
  prepared: ReturnType<typeof prepareOpenAICompatibleRequest>;
}): Promise<ChatMessage[]> {
  const { input, prepared } = params;
  ensureBootstrapFiles(prepared.requestAgentId);
  const workspacePath = path.resolve(
    agentWorkspaceDir(prepared.requestAgentId),
  );
  const sessionContext = buildSessionContext({
    source: {
      channelKind: 'openai',
      chatId: 'openai',
      chatType: 'dm',
      userId: prepared.sessionId,
      userName: input.user,
      guildId: null,
    },
    agentId: prepared.requestAgentId,
    sessionId: prepared.sessionId,
    sessionKey: prepared.sessionId,
    mainSessionKey: prepared.sessionId,
  });
  const { messages } = buildConversationContext({
    agentId: prepared.requestAgentId,
    history: [],
    currentUserContent: input.prompt,
    promptMode: prepared.profile.ablateSystemPrompt ? 'none' : 'full',
    includePromptParts: prepared.profile.includePromptParts,
    omitPromptParts: prepared.profile.omitPromptParts,
    runtimeInfo: {
      model: prepared.model,
      defaultModel: HYBRIDAI_MODEL,
      channelType: 'openai',
      channelId: 'openai',
      sessionContext,
      workspacePath,
    },
  });
  const systemPrompt = readSystemPromptMessage(messages);
  return systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...input.messages]
    : input.messages;
}

async function resolveToolAwareRuntime(params: {
  prepared: ReturnType<typeof prepareOpenAICompatibleRequest>;
}): Promise<Awaited<ReturnType<typeof resolveModelRuntimeCredentials>>> {
  const runtime = await resolveModelRuntimeCredentials({
    model: params.prepared.model,
    agentId: params.prepared.requestAgentId,
  });
  if (!modelRequiresChatbotId(params.prepared.model) || runtime.chatbotId) {
    return runtime;
  }
  const fallback = await resolveGatewayChatbotId({
    model: params.prepared.model,
    chatbotId: runtime.chatbotId,
    sessionId: params.prepared.sessionId,
    channelId: 'openai',
    agentId: params.prepared.requestAgentId,
    trigger: 'chat',
  });
  if (!fallback.chatbotId) {
    throw new OpenAICompatibleRequestError(
      500,
      fallback.error || 'No chatbot configured for the selected model.',
      {
        type: 'server_error',
      },
    );
  }
  return {
    ...runtime,
    chatbotId: fallback.chatbotId,
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
  responseModel: string,
  completionId: string,
  created: number,
): Promise<void> {
  const result = await runOpenAICompatibleChat(chatRequest);
  const payload = buildOpenAICompatibleCompletionResponse({
    completionId,
    created,
    model: responseModel,
    content: typeof result.result === 'string' ? result.result : '',
    tokenUsage: result.tokenUsage,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function handleOpenAICompatibleToolChat(
  res: ServerResponse,
  input: Awaited<ReturnType<typeof readOpenAICompatibleChatRequest>>,
  prepared: ReturnType<typeof prepareOpenAICompatibleRequest>,
  completionId: string,
  created: number,
): Promise<void> {
  const runtime = await resolveToolAwareRuntime({ prepared });
  const messages = await buildToolAwareMessages({ input, prepared });
  const result = await callOpenAICompatibleModel({
    runtime,
    model: prepared.model,
    messages,
    tools: input.tools,
    toolChoice: input.toolChoice,
  });
  const choice = result.choices[0];
  const payload = buildOpenAICompatibleCompletionResponse({
    completionId,
    created,
    model: prepared.responseModel,
    content:
      typeof choice?.message.content === 'string'
        ? choice.message.content
        : null,
    ...(choice?.message.tool_calls
      ? { toolCalls: choice.message.tool_calls }
      : {}),
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    tokenUsage: mapOpenAICompatibleUsageToTokenStats(result.usage),
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
  responseModel: string,
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
      model: responseModel,
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
            model: responseModel,
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
          model: responseModel,
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
          model: responseModel,
          content: finalText,
        }),
      );
    }

    writeOpenAICompatibleStreamChunk(
      res,
      buildOpenAICompatibleStreamStopChunk({
        completionId,
        created,
        model: responseModel,
      }),
    );

    if (includeUsage) {
      writeOpenAICompatibleStreamChunk(
        res,
        buildOpenAICompatibleStreamUsageChunk({
          completionId,
          created,
          model: responseModel,
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

async function handleOpenAICompatibleStreamingToolChat(
  req: IncomingMessage,
  res: ServerResponse,
  input: Awaited<ReturnType<typeof readOpenAICompatibleChatRequest>>,
  prepared: ReturnType<typeof prepareOpenAICompatibleRequest>,
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
      model: prepared.responseModel,
    }),
  );

  try {
    const runtime = await resolveToolAwareRuntime({ prepared });
    const messages = await buildToolAwareMessages({ input, prepared });
    const result = await callOpenAICompatibleModelStream({
      runtime,
      model: prepared.model,
      messages,
      tools: input.tools,
      toolChoice: input.toolChoice,
      onTextDelta: (delta) => {
        if (!isResponseWritable(res) || !delta) return;
        writeOpenAICompatibleStreamChunk(
          res,
          buildOpenAICompatibleStreamTextChunk({
            completionId,
            created,
            model: prepared.responseModel,
            content: delta,
          }),
        );
      },
    });
    if (!isResponseWritable(res)) return;
    const choice = result.choices[0];
    if (choice?.message.tool_calls && choice.message.tool_calls.length > 0) {
      writeOpenAICompatibleStreamChunk(
        res,
        buildOpenAICompatibleStreamToolCallsChunk({
          completionId,
          created,
          model: prepared.responseModel,
          toolCalls: choice.message.tool_calls,
        }),
      );
    }
    writeOpenAICompatibleStreamChunk(
      res,
      buildOpenAICompatibleStreamStopChunk({
        completionId,
        created,
        model: prepared.responseModel,
        ...(choice?.finish_reason
          ? { finishReason: choice.finish_reason }
          : {}),
      }),
    );
    if (includeUsage) {
      writeOpenAICompatibleStreamChunk(
        res,
        buildOpenAICompatibleStreamUsageChunk({
          completionId,
          created,
          model: prepared.responseModel,
          tokenUsage: mapOpenAICompatibleUsageToTokenStats(result.usage),
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
    const prepared = prepareOpenAICompatibleRequest(input);
    const completionId = `chatcmpl_${randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      if (input.usesClientTools) {
        if (input.wantsStream) {
          await handleOpenAICompatibleStreamingToolChat(
            req,
            res,
            input,
            prepared,
            input.includeUsage,
            completionId,
            created,
          );
          return;
        }
        await handleOpenAICompatibleToolChat(
          res,
          input,
          prepared,
          completionId,
          created,
        );
        return;
      }

      const chatRequest = buildGatewayChatRequest({
        input,
        prepared,
      });
      if (input.wantsStream) {
        await handleOpenAICompatibleStreamingChat(
          req,
          res,
          chatRequest,
          prepared.responseModel,
          input.includeUsage,
          completionId,
          created,
        );
        return;
      }

      await handleOpenAICompatibleNonStreamingChat(
        res,
        chatRequest,
        prepared.responseModel,
        completionId,
        created,
      );
    } finally {
      stopSessionExecution(prepared.sessionId);
      if (prepared.cleanupAgentId) {
        resetWorkspace(prepared.cleanupAgentId);
      }
    }
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
