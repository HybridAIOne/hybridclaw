import type {
  Middleware,
  MiddlewareContext,
  MiddlewarePhase,
  MiddlewareResult,
  MiddlewareSessionState,
  ToolDecision,
  ToolMiddlewareContext,
} from './types.js';

export const DEFAULT_MIDDLEWARE_TIMEOUTS_MS: Record<MiddlewarePhase, number> = {
  beforeAgent: 5_000,
  beforeModel: 5_000,
  afterModel: 500,
  beforeTool: 5_000,
  afterTool: 500,
  afterAgent: 500,
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label?: string,
): Promise<T> {
  if (!(timeoutMs > 0)) return promise;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          label
            ? `${label} timed out after ${timeoutMs}ms.`
            : `Middleware timed out after ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

function resolveTimeoutMs<
  TState extends MiddlewareSessionState,
  TContext extends MiddlewareContext<TState>,
  TToolContext extends ToolMiddlewareContext<TState>,
>(
  middleware: Middleware<TState, TContext, TToolContext>,
  phase: MiddlewarePhase,
): number {
  const override = middleware.timeoutsMs?.[phase];
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override >= 0
  ) {
    return override;
  }
  return DEFAULT_MIDDLEWARE_TIMEOUTS_MS[phase];
}

export function applyMiddlewareResult<
  TState extends MiddlewareSessionState,
  TContext extends MiddlewareContext<TState>,
>(ctx: TContext, result: MiddlewareResult<TState>): TContext {
  const nextState = result.stateUpdates
    ? { ...ctx.state, ...result.stateUpdates }
    : ctx.state;
  const nextMessages = result.messages
    ? [...ctx.messages, ...result.messages]
    : ctx.messages;
  return {
    ...ctx,
    state: nextState,
    messages: nextMessages,
  };
}

export class MiddlewareChain<
  TState extends MiddlewareSessionState,
  TContext extends MiddlewareContext<TState>,
  TToolContext extends ToolMiddlewareContext<TState>,
> {
  constructor(
    private readonly middlewares: Middleware<TState, TContext, TToolContext>[],
  ) {}

  private async runPhase(
    phase: Exclude<MiddlewarePhase, 'beforeTool'>,
    ctx: TContext | TToolContext,
  ): Promise<TContext | TToolContext> {
    let current = ctx;

    for (const middleware of this.middlewares) {
      if (!middleware.isEnabled(current.config)) continue;
      const hook = middleware[phase];
      if (!hook) continue;
      const timeoutMs = resolveTimeoutMs(middleware, phase);

      const result = await withTimeout(
        hook.call(middleware, current as never),
        timeoutMs,
        `Middleware "${middleware.name}" ${phase}`,
      );
      current = applyMiddlewareResult(current, result);
      if (result.halt) break;
    }

    return current;
  }

  async runBeforeAgent(ctx: TContext): Promise<TContext> {
    return (await this.runPhase('beforeAgent', ctx)) as TContext;
  }

  async runBeforeModel(ctx: TContext): Promise<TContext> {
    return (await this.runPhase('beforeModel', ctx)) as TContext;
  }

  async runAfterModel(ctx: TContext): Promise<TContext> {
    return (await this.runPhase('afterModel', ctx)) as TContext;
  }

  async runBeforeTool(
    ctx: TToolContext,
  ): Promise<{ ctx: TToolContext; decision: ToolDecision }> {
    let current = ctx;

    for (const middleware of this.middlewares) {
      if (!middleware.isEnabled(current.config)) continue;
      if (!middleware.beforeTool) continue;
      const timeoutMs = resolveTimeoutMs(middleware, 'beforeTool');

      const decision = await withTimeout(
        middleware.beforeTool.call(middleware, current),
        timeoutMs,
        `Middleware "${middleware.name}" beforeTool`,
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
    }

    return { ctx: current, decision: { action: 'continue' } };
  }

  async runAfterTool(ctx: TToolContext): Promise<TToolContext> {
    return (await this.runPhase('afterTool', ctx)) as TToolContext;
  }

  async runAfterAgent(ctx: TContext): Promise<TContext> {
    return (await this.runPhase('afterAgent', ctx)) as TContext;
  }
}
