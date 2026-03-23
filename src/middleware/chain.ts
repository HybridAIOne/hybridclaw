import { MiddlewareChainCore } from '../../container/shared/middleware-core.js';

export { DEFAULT_MIDDLEWARE_TIMEOUTS_MS } from '../../container/shared/middleware-core.js';

import type {
  Middleware,
  MiddlewareContext,
  MiddlewareResult,
  MiddlewareSessionState,
  ToolDecision,
  ToolMiddlewareContext,
} from './types.js';

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
> extends MiddlewareChainCore<
  Middleware<TState, TContext, TToolContext>,
  TContext,
  TToolContext,
  MiddlewareResult<TState>,
  ToolDecision
> {
  constructor(middlewares: Middleware<TState, TContext, TToolContext>[]) {
    super(middlewares, {
      applyResult: (ctx, result) =>
        applyMiddlewareResult(ctx as TContext | TToolContext, result) as
          | TContext
          | TToolContext,
      isEnabled: (middleware, ctx) => middleware.isEnabled(ctx.config),
      timeoutLabel: (middleware, phase) =>
        `Middleware "${middleware.name}" ${phase}`,
    });
  }
}
