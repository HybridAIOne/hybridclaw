/**
 * Routes loop summaries with historical tool schemas and completion metadata.
 * Unlike auxiliary text tools, compaction must reject partial and empty replies;
 * historical schemas describe evidence, never grant permission to execute tools.
 * A complete region must fit with room for reasoning and visible summary text;
 * this budget never authorizes truncating selected evidence.
 */
import { parsePositiveInteger } from '../shared/primitive-values.js';
import { DEFAULT_COMPRESSION_MAX_TOKENS } from '../shared/request-max-tokens.js';
import { compactInLoop } from './in-loop-compaction.js';
import { createInLoopCompactionArchive } from './in-loop-compaction-archive.js';
import {
  type AuxiliaryTaskContext,
  callAuxiliaryModel,
  resolveAuxiliaryTaskContext,
} from './providers/auxiliary.js';
import { estimateRoutedPromptOverheadTokens } from './providers/router.js';
import { estimateVisualMessageTokens } from './providers/visual-content.js';
import { haltIfShuttingDown } from './shutdown-latch.js';
import { accumulateApiUsage, estimateTextTokens } from './token-usage.js';
import type {
  ChatMessage,
  TaskModelPolicies,
  TokenUsageStats,
  ToolDefinition,
} from './types.js';

function historicalTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): ToolDefinition[] {
  const names = new Set(
    messages.flatMap((message) =>
      (message.tool_calls ?? []).map((call) => call.function.name),
    ),
  );
  return [...names].map(
    (name) =>
      tools.find((tool) => tool.function.name === name) ?? {
        type: 'function',
        function: {
          name,
          description:
            'Historical tool call for summarization only. Do not call this tool.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: true,
          },
        },
      },
  );
}

export async function compactInLoopWithModel(params: {
  sessionId: string;
  history: ChatMessage[];
  contextWindowTokens?: number;
  taskModels?: TaskModelPolicies;
  fallbackContext: AuxiliaryTaskContext;
  tools: ToolDefinition[];
  tokenUsage: TokenUsageStats;
}) {
  const budgetFor = (messages: ChatMessage[]) => {
    const context = resolveAuxiliaryTaskContext({
      task: 'compression',
      taskModels: params.taskModels,
      fallbackContext: params.fallbackContext,
      toolName: 'in_loop_compaction',
    });
    const tools = historicalTools(messages, params.tools);
    const inputTokens =
      estimateVisualMessageTokens(messages, { ...context, tools }) +
      estimateRoutedPromptOverheadTokens({ ...context, tools });
    const generationBudget =
      parsePositiveInteger(context.maxTokens) ?? DEFAULT_COMPRESSION_MAX_TOKENS;
    const maxTokens = context.contextWindow
      ? Math.min(
          generationBudget,
          Math.floor(context.contextWindow) - inputTokens,
        )
      : generationBudget;
    // Codex engineering decision, 2026-10-31: reserve the configured generation budget,
    // or half a small context window, rather than admit an input with no reply room.
    const reserve = context.contextWindow
      ? Math.min(generationBudget, Math.floor(context.contextWindow / 2))
      : generationBudget;
    return { context, tools, inputTokens, maxTokens, reserve };
  };
  return compactInLoop({
    history: params.history,
    contextWindowTokens: params.contextWindowTokens,
    archive: createInLoopCompactionArchive(params.sessionId),
    estimateTokens: (messages) =>
      estimateVisualMessageTokens(messages, {
        ...params.fallbackContext,
        tools: params.tools,
      }),
    inputFits: (messages) => {
      const { maxTokens, reserve } = budgetFor(messages);
      return maxTokens > 0 && maxTokens >= reserve;
    },
    summarize: async (messages) => {
      await haltIfShuttingDown();
      const { context, tools, inputTokens, maxTokens } = budgetFor(messages);
      params.tokenUsage.modelCalls += 1;
      params.tokenUsage.estimatedPromptTokens += inputTokens;
      console.error(
        `[context] compression request inputTokens=${inputTokens} windowTokens=${context.contextWindow ?? 'unknown'} maxOutputTokens=${maxTokens} historicalTools=${tools.length}`,
      );
      const result = await callAuxiliaryModel({
        task: 'compression',
        fallbackContext: context,
        toolName: 'in_loop_compaction',
        messages,
        tools,
        maxTokens,
      });
      accumulateApiUsage(params.tokenUsage, result.response);
      params.tokenUsage.estimatedCompletionTokens += estimateTextTokens(
        result.content,
      );
      return result.response;
    },
  });
}
