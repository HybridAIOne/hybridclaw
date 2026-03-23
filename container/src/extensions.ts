import { MiddlewareChainCore } from '../shared/middleware-core.js';
import type {
  MiddlewarePhase as RuntimeMiddlewarePhase,
  ToolDecision as RuntimeToolDecision,
} from '../shared/middleware-types.js';
import { applyContextGuard, type ContextGuardResult } from './context-guard.js';
import type { TokenEstimateCache } from './token-usage.js';
import {
  detectToolCallLoop,
  type ToolCallHistoryEntry,
} from './tool-loop-detection.js';
import type { ChatMessage, ContextGuardConfig, ToolCall } from './types.js';

type RuntimeEventName =
  | 'before_agent_start'
  | 'before_model_call'
  | 'after_model_call'
  | 'model_retry'
  | 'model_error'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'mcp_server_connected'
  | 'mcp_server_disconnected'
  | 'mcp_server_error'
  | 'mcp_tool_call'
  | 'turn_end';

interface RuntimeEventPayload {
  event: RuntimeEventName;
  [key: string]: unknown;
}

interface RuntimeMiddlewareResult {
  halt?: boolean;
}

interface RuntimeMiddlewareContext {
  event?: RuntimeEventPayload;
  history?: ChatMessage[];
  contextWindowTokens?: number;
  contextGuard?: ContextGuardConfig;
  tokenEstimateCache?: TokenEstimateCache;
}

interface RuntimeToolMiddlewareContext extends RuntimeMiddlewareContext {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallHistory: ToolCallHistoryEntry[];
  toolResult?: string;
}

interface RuntimeMiddleware {
  name: string;
  timeoutsMs?: Partial<Record<RuntimeMiddlewarePhase, number>>;
  isEnabled(): boolean;
  onEvent?: (payload: RuntimeEventPayload) => void | Promise<void>;
  beforeAgent?: (
    ctx: RuntimeMiddlewareContext,
  ) => RuntimeMiddlewareResult | Promise<RuntimeMiddlewareResult>;
  beforeModel?: (
    ctx: RuntimeMiddlewareContext,
  ) => RuntimeMiddlewareResult | Promise<RuntimeMiddlewareResult>;
  afterModel?: (
    ctx: RuntimeMiddlewareContext,
  ) => RuntimeMiddlewareResult | Promise<RuntimeMiddlewareResult>;
  beforeTool?: (
    ctx: RuntimeToolMiddlewareContext,
  ) => RuntimeToolDecision | Promise<RuntimeToolDecision>;
  afterTool?: (
    ctx: RuntimeToolMiddlewareContext,
  ) => RuntimeMiddlewareResult | Promise<RuntimeMiddlewareResult>;
  afterAgent?: (
    ctx: RuntimeMiddlewareContext,
  ) => RuntimeMiddlewareResult | Promise<RuntimeMiddlewareResult>;
}

const DANGEROUS_FILE_CONTENT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\brm\s+-rf\s+\/(\s|$)/i,
    reason:
      'Detected destructive root delete pattern (`rm -rf /`) in file content.',
  },
  {
    re: /:\(\)\s*\{.*\};\s*:/i,
    reason: 'Detected fork-bomb pattern in file content.',
  },
  {
    re: /\bcurl\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
    reason:
      'Detected remote shell execution pattern (`curl | sh`) in file content.',
  },
];

const DANGEROUS_BASH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\b(cat|sed|awk)\b[^|]*\.(env|pem|key|p12)\b[^|]*(\|\s*(curl|wget)|>\s*\/dev\/tcp)/i,
    reason: 'Command appears to exfiltrate sensitive local files.',
  },
  {
    re: /\b(printenv|env)\b[^|]*(\|\s*(curl|wget)|>\s*\/dev\/tcp)/i,
    reason: 'Command appears to exfiltrate environment variables.',
  },
];

const DANGLING_TOOL_CALL_RESULT =
  'Tool execution result was missing from history. Treat this prior tool call as interrupted and retry only if still needed.';

const EMPTY_CONTEXT_BUDGET_RESULT: ContextGuardResult = {
  totalTokensAfter: 0,
  overflowBudgetTokens: 0,
  truncatedToolResults: 0,
  compactedToolResults: 0,
  tier3Triggered: false,
};

function repairDanglingToolCalls(history: ChatMessage[]): {
  repairedCount: number;
  repairedCallIds: string[];
} {
  const repairedCallIds: string[] = [];

  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (
      message?.role !== 'assistant' ||
      !Array.isArray(message.tool_calls) ||
      message.tool_calls.length === 0
    ) {
      continue;
    }

    const expectedCalls = message.tool_calls.filter(
      (call): call is ToolCall =>
        typeof call?.id === 'string' && call.id.trim().length > 0,
    );
    if (expectedCalls.length === 0) continue;

    let insertIndex = index + 1;
    const observedToolCallIds = new Set<string>();
    while (
      insertIndex < history.length &&
      history[insertIndex]?.role === 'tool'
    ) {
      const toolCallId = String(
        history[insertIndex]?.tool_call_id || '',
      ).trim();
      if (toolCallId) {
        observedToolCallIds.add(toolCallId);
      }
      insertIndex += 1;
    }

    const missingCalls = expectedCalls.filter(
      (call) => !observedToolCallIds.has(call.id),
    );
    if (missingCalls.length === 0) continue;

    const syntheticToolResults = missingCalls.map(
      (call): ChatMessage => ({
        role: 'tool',
        content: `${DANGLING_TOOL_CALL_RESULT} Missing tool: ${call.function.name}.`,
        tool_call_id: call.id,
      }),
    );
    history.splice(insertIndex, 0, ...syntheticToolResults);
    repairedCallIds.push(...missingCalls.map((call) => call.id));
    index = insertIndex + syntheticToolResults.length - 1;
  }

  return {
    repairedCount: repairedCallIds.length,
    repairedCallIds,
  };
}

const securityHookMiddleware: RuntimeMiddleware = {
  name: 'security-hook',
  isEnabled: () => true,
  beforeTool: ({ toolName, toolArgs }) => {
    if (toolName === 'write' || toolName === 'edit') {
      const content =
        toolName === 'write'
          ? String(toolArgs.contents || '')
          : String(toolArgs.new || '');
      for (const pattern of DANGEROUS_FILE_CONTENT_PATTERNS) {
        if (pattern.re.test(content)) {
          return { action: 'deny', reason: pattern.reason };
        }
      }
    }

    if (toolName === 'bash') {
      const command = String(toolArgs.command || '');
      for (const pattern of DANGEROUS_BASH_PATTERNS) {
        if (pattern.re.test(command)) {
          return { action: 'deny', reason: pattern.reason };
        }
      }
    }

    return { action: 'continue' };
  },
};

const danglingToolCallMiddleware: RuntimeMiddleware = {
  name: 'dangling-tool-call',
  isEnabled: () => true,
  beforeModel: ({ event, history }) => {
    if (!history || history.length === 0) {
      return {};
    }

    const repaired = repairDanglingToolCalls(history);
    if (repaired.repairedCount === 0) {
      return {};
    }

    if (event) {
      event.repairedDanglingToolCalls = repaired.repairedCount;
      event.repairedToolCallIds = repaired.repairedCallIds;
    }
    console.error(
      `[middleware] repaired ${repaired.repairedCount} dangling tool call(s): ${repaired.repairedCallIds.join(', ')}`,
    );
    return {};
  },
};

const contextBudgetMiddleware: RuntimeMiddleware = {
  name: 'context-budget',
  isEnabled: () => true,
  beforeModel: ({
    event,
    history,
    contextWindowTokens,
    contextGuard,
    tokenEstimateCache,
  }) => {
    if (!history || history.length === 0) {
      if (event) {
        event.contextBudget = { ...EMPTY_CONTEXT_BUDGET_RESULT };
      }
      return {};
    }

    const result = applyContextGuard({
      history,
      contextWindowTokens,
      config: contextGuard,
      cache: tokenEstimateCache,
    });
    if (event) {
      event.contextBudget = result;
    }
    return {};
  },
};

const loopDetectionMiddleware: RuntimeMiddleware = {
  name: 'loop-detection',
  isEnabled: () => true,
  beforeTool: ({ toolName, toolArgs, toolCallHistory }) => {
    const loopGuard = detectToolCallLoop(
      toolCallHistory,
      toolName,
      JSON.stringify(toolArgs),
    );
    if (loopGuard.stuck) {
      return {
        action: 'deny',
        reason: loopGuard.message,
      };
    }
    return { action: 'continue' };
  },
};

const runtimeMiddlewares: RuntimeMiddleware[] = [
  danglingToolCallMiddleware,
  contextBudgetMiddleware,
  securityHookMiddleware,
  loopDetectionMiddleware,
];
const runtimeMiddlewareChain = new MiddlewareChainCore<
  RuntimeMiddleware,
  RuntimeMiddlewareContext,
  RuntimeToolMiddlewareContext,
  RuntimeMiddlewareResult,
  RuntimeToolDecision
>(runtimeMiddlewares, {
  applyResult: (ctx) => ctx,
  isEnabled: (middleware) => middleware.isEnabled(),
  timeoutLabel: () => undefined,
  onPhaseError: ({ ctx }) => {
    // Observers are best-effort. Broken middleware should not break the turn.
    return ctx;
  },
  onBeforeToolError: ({ error, middleware }) => ({
    action: 'deny',
    reason:
      error instanceof Error
        ? `Middleware ${middleware.name} failed: ${error.message}`
        : `Middleware ${middleware.name} failed.`,
  }),
});

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function emitRuntimeEvent(
  payload: RuntimeEventPayload,
  contextOverrides?: Partial<RuntimeMiddlewareContext>,
): Promise<void> {
  const context: RuntimeMiddlewareContext = {
    ...contextOverrides,
    event: payload,
  };
  if (payload.event === 'before_agent_start') {
    await runtimeMiddlewareChain.runBeforeAgent(context);
  } else if (payload.event === 'before_model_call') {
    await runtimeMiddlewareChain.runBeforeModel(context);
  } else if (payload.event === 'after_model_call') {
    await runtimeMiddlewareChain.runAfterModel(context);
  } else if (payload.event === 'turn_end') {
    await runtimeMiddlewareChain.runAfterAgent(context);
  }

  for (const middleware of runtimeMiddlewares) {
    if (!middleware.isEnabled() || !middleware.onEvent) continue;
    try {
      await middleware.onEvent(payload);
    } catch {
      // Best effort: observer errors should not break request handling.
    }
  }
}

export async function runBeforeModelHooks(params: {
  history: ChatMessage[];
  attempt?: number;
  contextWindowTokens?: number;
  contextGuard?: ContextGuardConfig;
  tokenEstimateCache?: TokenEstimateCache;
}): Promise<{
  repairedDanglingToolCalls: number;
  contextBudget: ContextGuardResult;
}> {
  const event: RuntimeEventPayload = {
    event: 'before_model_call',
    attempt: params.attempt,
  };
  await emitRuntimeEvent(event, {
    history: params.history,
    contextWindowTokens: params.contextWindowTokens,
    contextGuard: params.contextGuard,
    tokenEstimateCache: params.tokenEstimateCache,
  });
  return {
    repairedDanglingToolCalls:
      typeof event.repairedDanglingToolCalls === 'number'
        ? event.repairedDanglingToolCalls
        : 0,
    contextBudget: isContextBudgetResult(event.contextBudget)
      ? event.contextBudget
      : { ...EMPTY_CONTEXT_BUDGET_RESULT },
  };
}

function isContextBudgetResult(value: unknown): value is ContextGuardResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.totalTokensAfter === 'number' &&
    typeof record.overflowBudgetTokens === 'number' &&
    typeof record.truncatedToolResults === 'number' &&
    typeof record.compactedToolResults === 'number' &&
    typeof record.tier3Triggered === 'boolean'
  );
}

export async function runBeforeToolHooks(params: {
  toolName: string;
  argsJson: string;
  toolCallHistory: ToolCallHistoryEntry[];
}): Promise<{
  decision: RuntimeToolDecision;
  args: Record<string, unknown>;
}> {
  const args = parseArgs(params.argsJson);
  const { ctx, decision } = await runtimeMiddlewareChain.runBeforeTool({
    toolName: params.toolName,
    toolArgs: args,
    toolCallHistory: params.toolCallHistory,
  });
  const blocked =
    decision.action === 'deny' || decision.action === 'abort-turn';
  await emitRuntimeEvent({
    event: 'before_tool_call',
    toolName: params.toolName,
    blocked,
    modified:
      decision.action === 'continue' &&
      JSON.stringify(args) !== JSON.stringify(ctx.toolArgs),
    ...(blocked && 'reason' in decision ? { reason: decision.reason } : {}),
  });
  return {
    decision,
    args: ctx.toolArgs,
  };
}

export async function runAfterToolHooks(params: {
  toolName: string;
  argsJson: string;
  result: string;
  toolCallHistory: ToolCallHistoryEntry[];
}): Promise<void> {
  const args = parseArgs(params.argsJson);
  await runtimeMiddlewareChain.runAfterTool({
    toolName: params.toolName,
    toolArgs: args,
    toolCallHistory: params.toolCallHistory,
    toolResult: params.result,
  });
  await emitRuntimeEvent({
    event: 'after_tool_call',
    toolName: params.toolName,
  });
}
