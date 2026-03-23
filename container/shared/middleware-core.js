export const DEFAULT_MIDDLEWARE_TIMEOUTS_MS = {
  beforeAgent: 5_000,
  beforeModel: 5_000,
  afterModel: 500,
  beforeTool: 5_000,
  afterTool: 500,
  afterAgent: 500,
};

export function withMiddlewareTimeout(promise, timeoutMs, label) {
  if (!(timeoutMs > 0)) return promise;

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
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

export function resolveMiddlewareTimeoutMs(middleware, phase) {
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

function defaultApplyResult(ctx) {
  return ctx;
}

function defaultIsEnabled(middleware, ctx) {
  return middleware.isEnabled(ctx?.config);
}

function defaultTimeoutLabel(middleware, phase) {
  return `Middleware "${middleware.name}" ${phase}`;
}

function defaultThrow(params) {
  throw params.error;
}

function selectBeforeAgentHook(middleware) {
  return middleware.beforeAgent;
}

function selectBeforeModelHook(middleware) {
  return middleware.beforeModel;
}

function selectAfterModelHook(middleware) {
  return middleware.afterModel;
}

function selectAfterToolHook(middleware) {
  return middleware.afterTool;
}

function selectAfterAgentHook(middleware) {
  return middleware.afterAgent;
}

export class MiddlewareChainCore {
  constructor(middlewares, options = {}) {
    this.middlewares = middlewares;
    this.applyResult = options.applyResult || defaultApplyResult;
    this.isEnabled = options.isEnabled || defaultIsEnabled;
    this.timeoutLabel = options.timeoutLabel || defaultTimeoutLabel;
    this.onPhaseError = options.onPhaseError || defaultThrow;
    this.onBeforeToolError = options.onBeforeToolError || defaultThrow;
  }

  async runResultPhase(phase, ctx, selectHook) {
    let current = ctx;

    for (const middleware of this.middlewares) {
      if (!this.isEnabled(middleware, current)) continue;
      const hook = selectHook(middleware);
      if (!hook) continue;

      try {
        const result = await withMiddlewareTimeout(
          Promise.resolve(hook.call(middleware, current)),
          resolveMiddlewareTimeoutMs(middleware, phase),
          this.timeoutLabel(middleware, phase),
        );
        if (result != null) {
          current = this.applyResult(current, result);
        }
        if (result?.halt) break;
      } catch (error) {
        const next = await this.onPhaseError({
          error,
          middleware,
          phase,
          ctx: current,
        });
        if (next !== undefined) {
          current = next;
        }
      }
    }

    return current;
  }

  async runBeforeAgent(ctx) {
    return await this.runResultPhase('beforeAgent', ctx, selectBeforeAgentHook);
  }

  async runBeforeModel(ctx) {
    return await this.runResultPhase('beforeModel', ctx, selectBeforeModelHook);
  }

  async runAfterModel(ctx) {
    return await this.runResultPhase('afterModel', ctx, selectAfterModelHook);
  }

  async runAfterTool(ctx) {
    return await this.runResultPhase('afterTool', ctx, selectAfterToolHook);
  }

  async runAfterAgent(ctx) {
    return await this.runResultPhase('afterAgent', ctx, selectAfterAgentHook);
  }

  async runBeforeTool(ctx) {
    let current = ctx;

    for (const middleware of this.middlewares) {
      if (!this.isEnabled(middleware, current)) continue;
      if (!middleware.beforeTool) continue;

      try {
        const decision = await withMiddlewareTimeout(
          Promise.resolve(middleware.beforeTool.call(middleware, current)),
          resolveMiddlewareTimeoutMs(middleware, 'beforeTool'),
          this.timeoutLabel(middleware, 'beforeTool'),
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
          decision: await this.onBeforeToolError({
            error,
            middleware,
            ctx: current,
          }),
        };
      }
    }

    return { ctx: current, decision: { action: 'continue' } };
  }
}
