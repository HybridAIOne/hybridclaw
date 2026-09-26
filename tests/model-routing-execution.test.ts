import { describe, expect, test, vi } from 'vitest';
import {
  classifyModelRoutingOutput,
  executeModelRouting,
} from '../src/gateway/model-routing-execution.js';
import { resolveLadder } from '../src/providers/model-routing.js';
import type { ResolvedModelRuntimeCredentials } from '../src/providers/types.js';
import type { ContainerOutput } from '../src/types/container.js';

// Fallback-chain models resolve through the factory, not `resolveRuntime`.
vi.mock('../src/providers/factory.js', () => ({
  resolveModelRuntimeCredentials: async ({ model }: { model: string }) =>
    runtime(model),
}));

const config = {
  enabled: true,
  tiers: [
    { name: 'economy', models: ['local/small'] },
    { name: 'general', models: ['hybridai/medium'] },
  ],
  defaultStart: 'economy',
  escalationStickyTurns: 3,
};

function runtime(model: string): ResolvedModelRuntimeCredentials {
  return {
    provider: model.startsWith('local/') ? 'ollama' : 'hybridai',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: model.startsWith('local/'),
  };
}

function output(
  value: Partial<ContainerOutput> & Pick<ContainerOutput, 'status'>,
): ContainerOutput {
  return { result: '', toolsUsed: [], ...value };
}

describe('model routing escalation classification', () => {
  test.each([
    [output({ status: 'error', error: 'Provider returned HTTP 401' }), 'provider_auth'],
    [output({ status: 'error', error: 'Provider returned HTTP 429' }), 'provider_rate_limit'],
    [output({ status: 'error', error: 'Provider returned HTTP 503' }), 'provider_server_error'],
    [output({ status: 'error', error: 'Model emitted malformed tool arguments for `bash`' }), 'malformed_tool_call'],
    [output({ status: 'success', result: '' }), 'empty_output'],
    [output({ status: 'success', result: "I'll investigate this for you." }), 'narrate_only'],
  ])('classifies %#', (candidate, trigger) => {
    expect(classifyModelRoutingOutput(candidate)).toBe(trigger);
  });

  test('does not retry after a tool side effect or approval boundary', () => {
    expect(
      classifyModelRoutingOutput(
        output({
          status: 'error',
          error: 'HTTP 503',
          toolExecutions: [{ name: 'bash' } as never],
        }),
      ),
    ).toBeNull();
    expect(
      classifyModelRoutingOutput(
        output({
          status: 'error',
          error: 'HTTP 503',
          pendingApproval: { approvalId: 'approval-1' } as never,
        }),
      ),
    ).toBeNull();
  });
});

test('cheap-tier provider failure escalates once and returns the next rung', async () => {
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(output({ status: 'error', error: 'HTTP 503' }))
    .mockResolvedValueOnce(output({ status: 'success', result: 'done' }));
  const onEscalation = vi.fn();
  const result = await executeModelRouting({
    ladder: resolveLadder(config),
    agentId: 'main',
    resolveRuntime: async ({ model }) => runtime(model),
    invoke,
    onEscalation,
  });

  expect(result.output.result).toBe('done');
  expect(result.model).toBe('hybridai/medium');
  expect(result.attempts).toHaveLength(2);
  expect(result.escalated).toBe(true);
  expect(onEscalation).toHaveBeenCalledTimes(1);
  expect(onEscalation).toHaveBeenCalledWith({
    fromTier: 'economy',
    toTier: 'general',
    reason: 'provider_server_error',
  });
});

test('empty output receives one same-rung retry before escalation', async () => {
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(output({ status: 'success', result: '' }))
    .mockResolvedValueOnce(output({ status: 'success', result: 'completed' }));
  const onEscalation = vi.fn();
  const result = await executeModelRouting({
    ladder: resolveLadder(config),
    agentId: 'main',
    resolveRuntime: async ({ model }) => runtime(model),
    invoke,
    onEscalation,
  });

  expect(result.model).toBe('local/small');
  expect(result.attempts.map((attempt) => attempt.routeReason)).toEqual([
    'default-start',
    'empty_output_retry',
  ]);
  expect(onEscalation).not.toHaveBeenCalled();
});

test('a failed turn with tool execution is returned without rerouting', async () => {
  const failed = output({
    status: 'error',
    error: 'HTTP 503',
    toolExecutions: [{ name: 'bash' } as never],
  });
  const invoke = vi.fn().mockResolvedValue(failed);
  const onEscalation = vi.fn();
  const result = await executeModelRouting({
    ladder: resolveLadder(config),
    agentId: 'main',
    resolveRuntime: async ({ model }) => runtime(model),
    invoke,
    onEscalation,
  });

  expect(result.output).toBe(failed);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(onEscalation).not.toHaveBeenCalled();
});

test('a provider error thrown before any tool still escalates', async () => {
  const invoke = vi
    .fn()
    .mockRejectedValueOnce(new Error('Provider returned HTTP 503'))
    .mockResolvedValueOnce(output({ status: 'success', result: 'done' }));
  const onEscalation = vi.fn();
  const result = await executeModelRouting({
    ladder: resolveLadder(config),
    agentId: 'main',
    resolveRuntime: async ({ model }) => runtime(model),
    invoke,
    onEscalation,
  });

  expect(result.model).toBe('hybridai/medium');
  expect(onEscalation).toHaveBeenCalledWith({
    fromTier: 'economy',
    toTier: 'general',
    reason: 'provider_server_error',
  });
});

test.each([
  ['throws a provider error', new Error('Provider returned HTTP 503')],
  [
    'returns a provider error without executions',
    output({ status: 'error', error: 'Provider returned HTTP 503' }),
  ],
  ['returns empty output', output({ status: 'success', result: '' })],
])('an attempt that reported a tool and %s is never run again', async (_label, outcome) => {
  const invoke = vi.fn(
    async (_runtime: unknown, _model: string, markToolStarted: () => void) => {
      markToolStarted();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  );
  const onEscalation = vi.fn();
  const settled = await executeModelRouting({
    // A fallback model and a next rung leave every retry path open.
    ladder: resolveLadder({
      ...config,
      tiers: [
        { name: 'economy', models: ['local/small', 'local/backup'] },
        { name: 'general', models: ['hybridai/medium'] },
      ],
    }),
    agentId: 'main',
    resolveRuntime: async ({ model }) => runtime(model),
    invoke,
    onEscalation,
  }).then(
    (result) => result.output,
    (error: unknown) => error,
  );

  expect(settled).toBe(outcome);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(onEscalation).not.toHaveBeenCalled();
});

test('a later rung that reported a tool and threw surfaces its own error', async () => {
  const failure = new Error('container exited unexpectedly');
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(output({ status: 'error', error: 'HTTP 503' }))
    .mockImplementationOnce(
      async (_runtime: unknown, _model: string, markToolStarted: () => void) => {
        markToolStarted();
        throw failure;
      },
    );

  await expect(
    executeModelRouting({
      ladder: resolveLadder(config),
      agentId: 'main',
      resolveRuntime: async ({ model }) => runtime(model),
      invoke,
    }),
  ).rejects.toBe(failure);
  expect(invoke).toHaveBeenCalledTimes(2);
});
