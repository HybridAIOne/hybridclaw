// SECURITY: API key used only for LLM inference. Never forwarded to sandbox.

import {
  HYBRIDAI_BASE_URL,
  getHybridAIApiKey,
} from '../config.js';
import type {
  ChatMessage,
  ContainerOutput,
  DelegationSideEffect,
  ScheduleSideEffect,
  ToolExecution,
} from '../types.js';
import { SandboxClient } from './client.js';
import { dispatchTool } from './tool-dispatcher.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import type { AgentLoopOptions, ToolCall } from './types.js';

const MAX_ITERATIONS = 50;

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
}

// --- HybridAI LLM call ---

class HybridAIRequestError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HybridAI API error ${status}: ${body}`);
    this.name = 'HybridAIRequestError';
    this.status = status;
    this.body = body;
  }
}

async function callHybridAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  chatbotId: string,
  enableRag: boolean,
  messages: ChatMessage[],
  tools: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>,
): Promise<ChatCompletionResponse> {
  const url = `${baseUrl}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      chatbot_id: chatbotId,
      messages,
      tools,
      tool_choice: 'auto',
      enable_rag: enableRag,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new HybridAIRequestError(response.status, text);
  }

  return (await response.json()) as ChatCompletionResponse;
}

// --- Agent loop ---

export async function runAgentLoop(
  messages: ChatMessage[],
  sandboxId: string,
  options: AgentLoopOptions,
): Promise<ContainerOutput> {
  const client = new SandboxClient();
  const apiKey = getHybridAIApiKey();
  const baseUrl = HYBRIDAI_BASE_URL;
  const { chatbotId, model, enableRag, allowedTools, onToolProgress, abortSignal } = options;

  // Build tool definitions, filtered by allowlist
  let tools = TOOL_DEFINITIONS;
  if (allowedTools && allowedTools.length > 0) {
    const allowed = new Set(allowedTools);
    tools = tools.filter((t) => allowed.has(t.function.name));
  }

  const toolsUsed: string[] = [];
  const toolExecutions: ToolExecution[] = [];
  const pendingSchedules: ScheduleSideEffect[] = [];
  const pendingDelegations: DelegationSideEffect[] = [];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (abortSignal?.aborted) {
      return { status: 'error', result: null, toolsUsed, error: 'Interrupted by user.' };
    }

    let completion: ChatCompletionResponse;
    try {
      completion = await callHybridAI(baseUrl, apiKey, model, chatbotId, enableRag, messages, tools);
    } catch (err) {
      return {
        status: 'error',
        result: null,
        toolsUsed,
        toolExecutions,
        error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        sideEffects: collectSideEffects(pendingSchedules, pendingDelegations),
      };
    }

    const choice = completion.choices[0];
    if (!choice) {
      return {
        status: 'error',
        result: null,
        toolsUsed,
        toolExecutions,
        error: 'Empty response from LLM',
        sideEffects: collectSideEffects(pendingSchedules, pendingDelegations),
      };
    }

    const assistantMsg = choice.message;
    const finishReason = choice.finish_reason;

    // If no tool calls — return final answer
    if (finishReason === 'stop' || !assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return {
        status: 'success',
        result: assistantMsg.content,
        toolsUsed: [...new Set(toolsUsed)],
        toolExecutions,
        sideEffects: collectSideEffects(pendingSchedules, pendingDelegations),
      };
    }

    // Add assistant message with tool_calls to conversation
    messages.push({
      role: 'assistant',
      content: assistantMsg.content,
      tool_calls: assistantMsg.tool_calls,
    });

    // Execute each tool call
    for (const tc of assistantMsg.tool_calls) {
      const toolName = tc.function.name;
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        parsedArgs = {};
      }

      const toolCall: ToolCall = { id: tc.id, name: toolName, args: parsedArgs };
      toolsUsed.push(toolName);

      const startMs = Date.now();
      onToolProgress?.({
        sessionId: options.agentId,
        toolName,
        phase: 'start',
        preview: truncate(JSON.stringify(parsedArgs), 120),
      });

      const result = await dispatchTool(toolCall, sandboxId, client, {
        allowedTools,
        onProgress: (phase, preview, durationMs) => {
          if (phase === 'start' && preview) {
            onToolProgress?.({ sessionId: options.agentId, toolName, phase: 'start', preview });
          }
        },
        abortSignal,
      });

      const durationMs = Date.now() - startMs;
      onToolProgress?.({ sessionId: options.agentId, toolName, phase: 'finish', durationMs });

      toolExecutions.push({
        name: toolName,
        arguments: tc.function.arguments,
        result: result.content,
        durationMs,
      });

      // Handle side-effect sentinels
      if (result.isDelegate) {
        const raw = result.content.replace(/^__DELEGATE__:/, '');
        try {
          pendingDelegations.push(JSON.parse(raw) as DelegationSideEffect);
        } catch {
          // Malformed delegation — ignore
        }
        // Add a placeholder tool result so the LLM knows delegation was accepted
        messages.push({
          role: 'tool',
          content: 'Delegation accepted (auto-announces on completion, do not poll).',
          tool_call_id: tc.id,
        });
        continue;
      }

      if (result.content.startsWith('__CRON__:')) {
        const raw = result.content.replace(/^__CRON__:/, '');
        try {
          const cronArgs = JSON.parse(raw) as Record<string, unknown>;
          pendingSchedules.push(cronArgs as unknown as ScheduleSideEffect);
        } catch {
          // ignore
        }
        messages.push({
          role: 'tool',
          content: 'Cron action recorded.',
          tool_call_id: tc.id,
        });
        continue;
      }

      messages.push({
        role: 'tool',
        content: result.content,
        tool_call_id: tc.id,
      });
    }
  }

  // Exceeded max iterations
  return {
    status: 'error',
    result: null,
    toolsUsed: [...new Set(toolsUsed)],
    toolExecutions,
    error: `Agent loop exceeded maximum iterations (${MAX_ITERATIONS})`,
    sideEffects: collectSideEffects(pendingSchedules, pendingDelegations),
  };
}

function collectSideEffects(
  schedules: ScheduleSideEffect[],
  delegations: DelegationSideEffect[],
): ContainerOutput['sideEffects'] {
  if (schedules.length === 0 && delegations.length === 0) return undefined;
  return {
    schedules: schedules.length > 0 ? schedules : undefined,
    delegations: delegations.length > 0 ? delegations : undefined,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '...';
}
