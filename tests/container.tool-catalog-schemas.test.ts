import { describe, expect, test } from 'vitest';
import { ToolCatalog } from '../container/src/tool-catalog.js';
import type { ToolCall, ToolDefinition } from '../container/src/types.js';

function tool(name: string, parameters: ToolDefinition['function']['parameters']): ToolDefinition {
  return { type: 'function', function: { name, description: 'Lookup records.', parameters } };
}

function call(action: string, name = '', args?: Record<string, unknown>): ToolCall {
  return { id: 'lookup', type: 'function', function: { name: 'tool_catalog', arguments: JSON.stringify({ action, name, arguments: args }) } };
}

const parameters = {
  type: 'object' as const,
  properties: { ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 50 } },
  required: ['ids'],
  additionalProperties: false,
};

describe('input schemas supplied with catalog discovery', () => {
  test('allows execution directly from a search result without changing exposed tools', () => {
    const target = tool('records__lookup', parameters);
    const catalog = ToolCatalog.deferring([target], new Set([target.function.name]))!;
    const offered = JSON.stringify(catalog.tools);
    const result = JSON.parse(catalog.discoveryResult(call('list'))!.output);
    expect(result.tools[0].parameters).toEqual(parameters);
    expect(result.tools[0].next).toBeUndefined();
    const args = { ids: [1, 2, 3] };
    expect(catalog.resolveCall(call('call', result.tools[0].name, args)).function).toEqual({ name: target.function.name, arguments: JSON.stringify(args) });
    expect(JSON.stringify(catalog.tools)).toBe(offered);
  });

  test('supplies complete small schemas in the initial deferred index', () => {
    const target = tool('records__lookup', parameters);
    const catalog = ToolCatalog.deferring([target], new Set([target.function.name]))!;
    const indexed = catalog.promptGuidance().split('\n').find((line) => line.startsWith('  parameters: '));
    expect(JSON.parse(indexed!.slice('  parameters: '.length))).toEqual(parameters);
    expect(catalog.promptGuidance()).toBe(catalog.promptGuidance());
  });

  test.each([
    { ids: [] }, { ids: Array(51).fill(1) }, { ids: ['1'] }, { ids: [1], extra: true },
  ])('keeps schema validation even without a describe call: %j', (args) => {
    const catalog = new ToolCatalog([tool('records__lookup', parameters)], []);
    catalog.discoveryResult(call('list'));
    expect(() => catalog.resolveCall(call('call', 'records__lookup', args))).toThrow('do not match');
  });

  test('retains explicit discovery for large schemas without truncating their rules', () => {
    const schema = { ...parameters, description: 'x'.repeat(2100) };
    const target = tool('records__lookup', schema);
    const catalog = ToolCatalog.deferring([target], new Set([target.function.name]))!;
    const result = JSON.parse(catalog.discoveryResult(call('list'))!.output);
    expect(result.tools[0].parameters).toBeUndefined();
    expect(result.tools[0].next.arguments).toEqual({ action: 'describe', name: target.function.name });
    expect(catalog.promptGuidance()).not.toContain(JSON.stringify(schema));
    const described = JSON.parse(catalog.discoveryResult(call('describe', target.function.name))!.output);
    expect(described.function.parameters.properties.arguments).toEqual(schema);
  });

  test('bounds inline schema text across a deferred index and excludes unavailable tools', () => {
    const targets = Array.from({ length: 40 }, (_, i) => tool(`records__lookup_${i}`, { ...parameters, description: 'x'.repeat(1500) }));
    const catalog = ToolCatalog.deferring(targets, new Set(targets.map((entry) => entry.function.name)))!;
    const schemas = catalog.promptGuidance().split('\n').filter((line) => line.startsWith('  parameters: '));
    expect(schemas.length).toBeGreaterThan(0);
    expect(schemas.length).toBeLessThan(targets.length);
    expect(schemas.reduce((size, line) => size + line.slice('  parameters: '.length).length, 0)).toBeLessThanOrEqual(24_000);
    expect(() => catalog.resolveCall(call('call', 'records__missing', { ids: [1] }))).toThrow('not available');
  });
});
