import { describe, expect, test, vi } from 'vitest';
import { classifyProviderError } from '#shared/provider-fallback.js';
import { isRetryableModelError } from '../container/src/model-retry.js';
import type { RuntimeProviderId } from '../container/src/providers/provider-ids.js';
import { ProviderRequestError } from '../container/src/providers/shared.js';
import { ToolCatalog } from '../container/src/tool-catalog.js';
import {
  deferMcpToolsOverLimit,
  resolveToolCountLimit,
  toolCountLimitFailure,
} from '../container/src/tool-count-limit.js';
import type { ToolDefinition } from '../container/src/types.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ restoreAllMocks: true });

function tool(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: 'Lookup records.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: [],
      },
    },
  };
}

function tools(prefix: string, count: number): ToolDefinition[] {
  return Array.from({ length: count }, (_, i) => tool(`${prefix}${i}`));
}

/** The remote request path: cap-driven deferral, catalog, then preflight. */
function plan(
  provider: RuntimeProviderId | undefined,
  builtIns: number,
  mcp: number,
  reviewedRead = false,
) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const mcpTools = tools('srv__tool_', mcp);
  const available = [...tools('builtin_', builtIns), ...mcpTools];
  const limit = resolveToolCountLimit(provider, 'model-a');
  const deferred = deferMcpToolsOverLimit(
    available,
    [],
    mcpTools.map((entry) => entry.function.name),
    limit,
  );
  const catalog =
    deferred.length > 0
      ? ToolCatalog.deferring(
          available,
          new Set(deferred),
          () => reviewedRead,
          limit,
        )
      : null;
  const exposed = catalog?.tools ?? available;
  return {
    limit,
    deferred,
    exposed: exposed.map((entry) => entry.function.name),
    failure: toolCountLimitFailure(exposed, limit, provider, 'model-a'),
  };
}

describe('provider tool-count cap', () => {
  test.each([
    { provider: 'openai', builtIns: 20, mcp: 100 },
    { provider: 'openai-codex', builtIns: 20, mcp: 100 },
    { provider: undefined, builtIns: 20, mcp: 100 },
    { provider: 'anthropic', builtIns: 100, mcp: 400 },
    { provider: 'openrouter', builtIns: 100, mcp: 400 },
  ] as const)('leaves %j unchanged', ({ provider, builtIns, mcp }) => {
    const result = plan(provider, builtIns, mcp);
    expect(result.deferred).toEqual([]);
    expect(result.exposed).toHaveLength(builtIns + mcp);
    expect(result.failure).toBeNull();
  });

  test.each([
    { provider: 'openai', reviewedRead: false },
    { provider: 'hybridai', reviewedRead: false },
    { provider: undefined, reviewedRead: true },
  ] as const)('defers every MCP tool when %j would exceed the cap', ({
    provider,
    reviewedRead,
  }) => {
    const result = plan(provider, 40, 140, reviewedRead);
    expect(result.limit).toBeDefined();
    expect(result.deferred).toHaveLength(140);
    expect(result.exposed).toContain('tool_catalog');
    expect(result.exposed.length).toBeLessThanOrEqual(result.limit ?? 0);
    expect(result.failure).toBeNull();
  });

  test('fails before sending when built-ins alone exceed the cap', () => {
    const result = plan('openai', 130, 10);
    expect(result.exposed.length).toBeGreaterThan(result.limit ?? 0);
    expect(result.failure).toMatchObject({ status: 'error', toolsUsed: [] });
    expect(result.failure?.error).toContain(
      `${result.exposed.length} > ${result.limit}`,
    );
    expect(classifyProviderError(result.failure?.error)).toBe('other');
  });
});

describe('deterministic provider rejections', () => {
  const toolsRejection = (length: number) => ({
    error: {
      message: `Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length ${length} instead.`,
      type: 'invalid_request_error',
      param: 'tools',
      code: 'array_above_max_length',
    },
  });

  test.each([
    180, 512,
  ])('surfaces a 400 for %i tools without retry or fallback', (length) => {
    const body = toolsRejection(length);
    const error = new ProviderRequestError(400, JSON.stringify(body));
    expect(error.message).toContain(body.error.message);
    expect(isRetryableModelError(error)).toBe(false);
    expect(classifyProviderError(error)).toBe('other');
    expect(classifyProviderError(`API error: ${error.message}`)).toBe('other');
  });

  test.each([
    { status: 401, reason: 'auth' },
    { status: 429, reason: 'rate_limit' },
    { status: 503, reason: 'server_error' },
  ])('still classifies a $status by its status', ({ status, reason }) => {
    const error = new ProviderRequestError(
      status,
      JSON.stringify(toolsRejection(180)),
    );
    expect(classifyProviderError(error)).toBe(reason);
  });
});
