import type { MiddlewarePhase, ToolDecision } from './middleware-types.js';

export declare const DEFAULT_MIDDLEWARE_TIMEOUTS_MS: Record<
  MiddlewarePhase,
  number
>;

export declare function withMiddlewareTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label?: string,
): Promise<T>;

export declare function resolveMiddlewareTimeoutMs<
  TMiddleware extends {
    timeoutsMs?: Partial<Record<MiddlewarePhase, number>>;
  },
>(middleware: TMiddleware, phase: MiddlewarePhase): number;

export interface MiddlewareChainCoreOptions<
  TMiddleware extends {
    name: string;
    timeoutsMs?: Partial<Record<MiddlewarePhase, number>>;
    beforeAgent?: (ctx: TContext) => Promise<TResult> | TResult;
    beforeModel?: (ctx: TContext) => Promise<TResult> | TResult;
    afterModel?: (ctx: TContext) => Promise<TResult> | TResult;
    beforeTool?: (ctx: TToolContext) => Promise<TToolDecision> | TToolDecision;
    afterTool?: (ctx: TToolContext) => Promise<TResult> | TResult;
    afterAgent?: (ctx: TContext) => Promise<TResult> | TResult;
  },
  TContext,
  TToolContext,
  TResult extends { halt?: boolean },
  TToolDecision extends { action: string } = ToolDecision,
> {
  applyResult?: (
    ctx: TContext | TToolContext,
    result: TResult,
  ) => TContext | TToolContext;
  isEnabled?: (
    middleware: TMiddleware,
    ctx: TContext | TToolContext,
  ) => boolean;
  timeoutLabel?: (
    middleware: TMiddleware,
    phase: MiddlewarePhase,
  ) => string | undefined;
  onPhaseError?: (params: {
    error: unknown;
    middleware: TMiddleware;
    phase: Exclude<MiddlewarePhase, 'beforeTool'>;
    ctx: TContext | TToolContext;
  }) => Promise<TContext | TToolContext | void> | TContext | TToolContext | void;
  onBeforeToolError?: (params: {
    error: unknown;
    middleware: TMiddleware;
    ctx: TToolContext;
  }) => Promise<TToolDecision> | TToolDecision;
}

export declare class MiddlewareChainCore<
  TMiddleware extends {
    name: string;
    timeoutsMs?: Partial<Record<MiddlewarePhase, number>>;
    beforeAgent?: (ctx: TContext) => Promise<TResult> | TResult;
    beforeModel?: (ctx: TContext) => Promise<TResult> | TResult;
    afterModel?: (ctx: TContext) => Promise<TResult> | TResult;
    beforeTool?: (ctx: TToolContext) => Promise<TToolDecision> | TToolDecision;
    afterTool?: (ctx: TToolContext) => Promise<TResult> | TResult;
    afterAgent?: (ctx: TContext) => Promise<TResult> | TResult;
  },
  TContext,
  TToolContext,
  TResult extends { halt?: boolean },
  TToolDecision extends { action: string } = ToolDecision,
> {
  constructor(
    middlewares: TMiddleware[],
    options?: MiddlewareChainCoreOptions<
      TMiddleware,
      TContext,
      TToolContext,
      TResult,
      TToolDecision
    >,
  );

  runBeforeAgent(ctx: TContext): Promise<TContext>;
  runBeforeModel(ctx: TContext): Promise<TContext>;
  runAfterModel(ctx: TContext): Promise<TContext>;
  runBeforeTool(
    ctx: TToolContext,
  ): Promise<{ ctx: TToolContext; decision: TToolDecision }>;
  runAfterTool(ctx: TToolContext): Promise<TToolContext>;
  runAfterAgent(ctx: TContext): Promise<TContext>;
}
