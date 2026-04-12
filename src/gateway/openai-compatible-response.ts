import type { ServerResponse } from 'node:http';
import type { ToolCall } from '../types/api.js';
import type { TokenUsageStats } from '../types/usage.js';

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload, null, 2));
}

export function sendOpenAICompatibleError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  options?: {
    type?: string;
    param?: string;
    code?: string;
  },
): void {
  sendJson(res, statusCode, {
    error: {
      message,
      type: options?.type || 'invalid_request_error',
      param: options?.param ?? null,
      code: options?.code ?? null,
    },
  });
}

export function mapOpenAICompatibleUsage(tokenUsage?: TokenUsageStats): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const promptTokens = tokenUsage?.apiUsageAvailable
    ? tokenUsage.apiPromptTokens
    : tokenUsage?.estimatedPromptTokens || 0;
  const completionTokens = tokenUsage?.apiUsageAvailable
    ? tokenUsage.apiCompletionTokens
    : tokenUsage?.estimatedCompletionTokens || 0;
  const totalTokens = tokenUsage?.apiUsageAvailable
    ? tokenUsage.apiTotalTokens
    : tokenUsage?.estimatedTotalTokens || promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

export function buildOpenAICompatibleModelsResponse(modelIds: string[]): {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }>;
} {
  return {
    object: 'list',
    data: modelIds.map((modelId) => ({
      id: modelId,
      object: 'model',
      created: 0,
      owned_by: 'hybridclaw',
    })),
  };
}

export function buildOpenAICompatibleCompletionResponse(params: {
  completionId: string;
  created: number;
  model: string;
  content: string | null;
  toolCalls?: ToolCall[];
  finishReason?: string;
  tokenUsage?: TokenUsageStats;
}): Record<string, unknown> {
  return {
    id: params.completionId,
    object: 'chat.completion',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: params.content,
          ...(params.toolCalls && params.toolCalls.length > 0
            ? { tool_calls: params.toolCalls }
            : {}),
        },
        finish_reason:
          params.finishReason ||
          (params.toolCalls && params.toolCalls.length > 0
            ? 'tool_calls'
            : 'stop'),
      },
    ],
    usage: mapOpenAICompatibleUsage(params.tokenUsage),
  };
}

export function writeOpenAICompatibleStreamChunk(
  res: ServerResponse,
  payload: Record<string, unknown> | '[DONE]',
): void {
  res.write(
    `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`,
  );
}

export function buildOpenAICompatibleStreamRoleChunk(params: {
  completionId: string;
  created: number;
  model: string;
}): Record<string, unknown> {
  return {
    id: params.completionId,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
        },
        finish_reason: null,
      },
    ],
  };
}

export function buildOpenAICompatibleStreamTextChunk(params: {
  completionId: string;
  created: number;
  model: string;
  content: string;
}): Record<string, unknown> {
  return {
    id: params.completionId,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {
          content: params.content,
        },
        finish_reason: null,
      },
    ],
  };
}

export function buildOpenAICompatibleStreamStopChunk(params: {
  completionId: string;
  created: number;
  model: string;
  finishReason?: string;
}): Record<string, unknown> {
  return {
    id: params.completionId,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: params.finishReason || 'stop',
      },
    ],
  };
}

export function buildOpenAICompatibleStreamToolCallsChunk(params: {
  completionId: string;
  created: number;
  model: string;
  toolCalls: ToolCall[];
}): Record<string, unknown> {
  return {
    id: params.completionId,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: params.toolCalls.map((toolCall, index) => ({
            index,
            id: toolCall.id,
            type: toolCall.type,
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          })),
        },
        finish_reason: null,
      },
    ],
  };
}

export function buildOpenAICompatibleStreamUsageChunk(params: {
  completionId: string;
  created: number;
  model: string;
  tokenUsage?: TokenUsageStats;
}): Record<string, unknown> {
  return {
    id: params.completionId,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [],
    usage: mapOpenAICompatibleUsage(params.tokenUsage),
  };
}

export function sendOpenAICompatibleStreamError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  options?: {
    type?: string;
    param?: string;
    code?: string;
  },
): void {
  if (!res.headersSent) {
    sendOpenAICompatibleError(res, statusCode, message, options);
    return;
  }
  writeOpenAICompatibleStreamChunk(res, {
    error: {
      message,
      type: options?.type || 'server_error',
      param: options?.param ?? null,
      code: options?.code ?? null,
    },
  });
  writeOpenAICompatibleStreamChunk(res, '[DONE]');
  res.end();
}
