import { expect, test } from 'vitest';

import { MiddlewareChainCore } from '../container/shared/middleware-core.js';
import { getRuntimeConfig } from '../src/config/runtime-config.js';
import { MiddlewareChain } from '../src/middleware/chain.js';
import type {
  Middleware,
  MiddlewareContext,
  MiddlewareSessionState,
  ToolMiddlewareContext,
} from '../src/middleware/types.js';

interface TestState extends MiddlewareSessionState {
  steps: string[];
  counter: number;
}

type TestContext = MiddlewareContext<TestState>;
type TestToolContext = ToolMiddlewareContext<TestState>;

test('MiddlewareChain applies ordered state updates and halts when requested', async () => {
  const chain = new MiddlewareChain<TestState, TestContext, TestToolContext>([
    {
      name: 'first',
      isEnabled: () => true,
      async beforeAgent(ctx) {
        return {
          stateUpdates: {
            counter: ctx.state.counter + 1,
            steps: [...ctx.state.steps, 'first'],
          },
          messages: [{ role: 'system', content: 'first' }],
        };
      },
    },
    {
      name: 'second',
      isEnabled: () => true,
      async beforeAgent(ctx) {
        return {
          stateUpdates: {
            counter: ctx.state.counter + 1,
            steps: [...ctx.state.steps, 'second'],
          },
          halt: true,
        };
      },
    },
    {
      name: 'third',
      isEnabled: () => true,
      async beforeAgent() {
        return {
          stateUpdates: {
            counter: 999,
            steps: ['third'],
          },
        };
      },
    },
  ]);

  const result = await chain.runBeforeAgent({
    config: getRuntimeConfig(),
    messages: [],
    state: {
      steps: [],
      counter: 0,
    },
  });

  expect(result.state.counter).toBe(2);
  expect(result.state.steps).toEqual(['first', 'second']);
  expect(result.messages).toEqual([{ role: 'system', content: 'first' }]);
});

test('MiddlewareChain supports tool argument modification and explicit denial', async () => {
  const chain = new MiddlewareChain<TestState, TestContext, TestToolContext>([
    {
      name: 'rewrite',
      isEnabled: () => true,
      async beforeTool(ctx) {
        return {
          action: 'modify',
          args: {
            ...ctx.toolArgs,
            rewritten: true,
          },
        };
      },
    },
    {
      name: 'deny',
      isEnabled: () => true,
      async beforeTool(ctx) {
        if (ctx.toolArgs.rewritten === true) {
          return {
            action: 'deny',
            reason: 'rewritten args must not proceed',
          };
        }
        return { action: 'continue' };
      },
    },
  ] satisfies Middleware<TestState, TestContext, TestToolContext>[]);

  const result = await chain.runBeforeTool({
    config: getRuntimeConfig(),
    messages: [],
    state: {
      steps: [],
      counter: 0,
    },
    toolName: 'demo',
    toolArgs: {
      original: true,
    },
  });

  expect(result.ctx.toolArgs).toEqual({
    original: true,
    rewritten: true,
  });
  expect(result.decision).toEqual({
    action: 'deny',
    reason: 'rewritten args must not proceed',
  });
});

test('MiddlewareChain timeout errors include the middleware name and phase', async () => {
  const chain = new MiddlewareChain<TestState, TestContext, TestToolContext>([
    {
      name: 'slow',
      isEnabled: () => true,
      timeoutsMs: {
        beforeAgent: 10,
      },
      async beforeAgent() {
        return await new Promise(() => {});
      },
    },
  ]);

  await expect(
    chain.runBeforeAgent({
      config: getRuntimeConfig(),
      messages: [],
      state: {
        steps: [],
        counter: 0,
      },
    }),
  ).rejects.toThrow('Middleware "slow" beforeAgent timed out after 10ms.');
});

test('MiddlewareChainCore supports best-effort phase errors and custom beforeTool failures', async () => {
  type CoreContext = { toolName?: string; toolArgs?: Record<string, unknown> };
  type CoreToolContext = {
    toolName: string;
    toolArgs: Record<string, unknown>;
  };
  type CoreResult = { halt?: boolean };

  const chain = new MiddlewareChainCore<
    {
      name: string;
      isEnabled(): boolean;
      beforeModel?: (ctx: CoreContext) => Promise<CoreResult> | CoreResult;
      beforeTool?: (
        ctx: CoreToolContext,
      ) =>
        | Promise<{ action: string; reason?: string }>
        | { action: string; reason?: string };
    },
    CoreContext,
    CoreToolContext,
    CoreResult,
    { action: 'deny'; reason: string } | { action: 'continue' }
  >(
    [
      {
        name: 'broken-observer',
        isEnabled: () => true,
        beforeModel() {
          throw new Error('observer exploded');
        },
      },
      {
        name: 'broken-tool-guard',
        isEnabled: () => true,
        beforeTool() {
          throw new Error('tool exploded');
        },
      },
    ],
    {
      applyResult: (ctx) => ctx,
      isEnabled: (middleware) => middleware.isEnabled(),
      timeoutLabel: () => undefined,
      onPhaseError: ({ ctx }) => ctx,
      onBeforeToolError: ({ error, middleware }) => ({
        action: 'deny',
        reason:
          error instanceof Error
            ? `Middleware ${middleware.name} failed: ${error.message}`
            : `Middleware ${middleware.name} failed.`,
      }),
    },
  );

  await expect(chain.runBeforeModel({})).resolves.toEqual({});
  await expect(
    chain.runBeforeTool({
      toolName: 'demo',
      toolArgs: {},
    }),
  ).resolves.toEqual({
    ctx: {
      toolName: 'demo',
      toolArgs: {},
    },
    decision: {
      action: 'deny',
      reason: 'Middleware broken-tool-guard failed: tool exploded',
    },
  });
});
