import {
  detectToolCallLoop,
  type ToolCallHistoryEntry,
} from './tool-loop-detection.js';

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

type RuntimeMiddlewarePhase =
  | 'beforeAgent'
  | 'beforeModel'
  | 'afterModel'
  | 'beforeTool'
  | 'afterTool'
  | 'afterAgent';

type RuntimeToolDecision =
  | { action: 'continue' }
  | { action: 'modify'; args: Record<string, unknown> }
  | { action: 'deny'; reason: string }
  | { action: 'abort-turn'; reason: string };

interface RuntimeMiddlewareResult {
  halt?: boolean;
}

interface RuntimeMiddlewareContext {
  event?: RuntimeEventPayload;
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

const DEFAULT_TIMEOUTS_MS: Record<RuntimeMiddlewarePhase, number> = {
  beforeAgent: 5_000,
  beforeModel: 5_000,
  afterModel: 500,
  beforeTool: 5_000,
  afterTool: 500,
  afterAgent: 500,
};

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!(timeoutMs > 0)) return promise;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Middleware timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

function resolveTimeoutMs(
  middleware: RuntimeMiddleware,
  phase: RuntimeMiddlewarePhase,
): number {
  const override = middleware.timeoutsMs?.[phase];
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override >= 0
  ) {
    return override;
  }
  return DEFAULT_TIMEOUTS_MS[phase];
}

class RuntimeMiddlewareChain {
  constructor(private readonly middlewares: RuntimeMiddleware[]) {}

  private async runPhase(
    phase: Exclude<RuntimeMiddlewarePhase, 'beforeTool'>,
    ctx: RuntimeMiddlewareContext | RuntimeToolMiddlewareContext,
  ): Promise<void> {
    for (const middleware of this.middlewares) {
      if (!middleware.isEnabled()) continue;
      const hook = middleware[phase];
      if (!hook) continue;
      try {
        const result = await withTimeout(
          Promise.resolve(hook(ctx as never)),
          resolveTimeoutMs(middleware, phase),
        );
        if (result.halt) break;
      } catch {
        // Observers are best-effort. Broken middleware should not break the turn.
      }
    }
  }

  async runBeforeAgent(ctx: RuntimeMiddlewareContext): Promise<void> {
    await this.runPhase('beforeAgent', ctx);
  }

  async runBeforeModel(ctx: RuntimeMiddlewareContext): Promise<void> {
    await this.runPhase('beforeModel', ctx);
  }

  async runAfterModel(ctx: RuntimeMiddlewareContext): Promise<void> {
    await this.runPhase('afterModel', ctx);
  }

  async runAfterTool(ctx: RuntimeToolMiddlewareContext): Promise<void> {
    await this.runPhase('afterTool', ctx);
  }

  async runAfterAgent(ctx: RuntimeMiddlewareContext): Promise<void> {
    await this.runPhase('afterAgent', ctx);
  }

  async runBeforeTool(ctx: RuntimeToolMiddlewareContext): Promise<{
    ctx: RuntimeToolMiddlewareContext;
    decision: RuntimeToolDecision;
  }> {
    let current = ctx;

    for (const middleware of this.middlewares) {
      if (!middleware.isEnabled()) continue;
      if (!middleware.beforeTool) continue;
      try {
        const decision = await withTimeout(
          Promise.resolve(middleware.beforeTool(current)),
          resolveTimeoutMs(middleware, 'beforeTool'),
        );
        if (decision.action === 'modify') {
          current = {
            ...current,
            toolArgs: { ...decision.args },
          };
          continue;
        }
        if (decision.action !== 'continue') {
          return { ctx: current, decision };
        }
      } catch (error) {
        return {
          ctx: current,
          decision: {
            action: 'deny',
            reason:
              error instanceof Error
                ? `Middleware ${middleware.name} failed: ${error.message}`
                : `Middleware ${middleware.name} failed.`,
          },
        };
      }
    }

    return { ctx: current, decision: { action: 'continue' } };
  }
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
  securityHookMiddleware,
  loopDetectionMiddleware,
];
const runtimeMiddlewareChain = new RuntimeMiddlewareChain(runtimeMiddlewares);

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
): Promise<void> {
  const context: RuntimeMiddlewareContext = { event: payload };
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
