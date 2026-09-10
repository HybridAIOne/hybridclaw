import { describe, expect, test } from 'vitest';
import { DEFAULT_LOCAL_STARTER_TOOLS, normalizeLocalStarterTools } from '../container/shared/local-tool-config.js';
import { LocalToolCatalog } from '../container/src/local-tool-catalog.js';
import { getToolExecutionMode } from '../container/src/tool-parallelism.js';
import type { ToolCall, ToolDefinition } from '../container/src/types.js';

function tool(name: string, description = name): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: {}, required: [] } } };
}
function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function catalogCall(args: Record<string, unknown>): ToolCall { return call('tool_catalog', args); }
const available = [...DEFAULT_LOCAL_STARTER_TOOLS.map((name) => tool(name)), tool('memory'), tool('mcp__lookup')];

describe('local tool catalog boundary', () => {
  test('offers nine starters plus discovery without growing model definitions', () => {
    const catalog = new LocalToolCatalog(available);
    const before = JSON.stringify(catalog.tools);
    expect(catalog.tools).toHaveLength(10);
    expect(catalog.tools.map((entry) => entry.function.name)).not.toContain('memory');
    expect(catalog.discoveryResult(catalogCall({ action: 'describe', name: 'memory' }))?.output).toContain('parameters');
    catalog.resolveCall(catalogCall({ action: 'call', name: 'memory', arguments: {} }));
    expect(JSON.stringify(catalog.tools)).toBe(before);
  });
  test('uses the configured selection, including catalog-only mode', () => {
    expect(new LocalToolCatalog(available, ['memory']).tools.map((entry) => entry.function.name)).toEqual(['memory', 'tool_catalog']);
    expect(new LocalToolCatalog(available, []).tools.map((entry) => entry.function.name)).toEqual(['tool_catalog']);
  });
  test('never restores filtered tools, including direct and replayed calls', () => {
    const catalog = new LocalToolCatalog([tool('read'), tool('memory')], ['bash']);
    for (const request of [catalogCall({ action: 'describe', name: 'bash' }), catalogCall({ action: 'call', name: 'bash', arguments: {} }), call('bash', {})]) expect(() => catalog.resolveCall(request)).toThrow('not available');
    expect(catalog.discoveryResult(catalogCall({ action: 'list' }))?.output).not.toContain('bash');
    expect(new LocalToolCatalog([]).tools).toEqual([]);
    expect(() => new LocalToolCatalog([]).resolveCall(catalogCall({ action: 'list' }))).toThrow('not available');
  });
  test('resolves the real action before batching and preserves model history', () => {
    const catalog = new LocalToolCatalog(available);
    const original = catalogCall({ action: 'call', name: 'bash', arguments: { command: 'pwd' } });
    const resolved = catalog.resolveCall(original);
    expect(resolved.id).toBe(original.id);
    expect(resolved.function).toEqual({ name: 'bash', arguments: '{"command":"pwd"}' });
    expect(original.function.name).toBe('tool_catalog');
    expect(getToolExecutionMode(resolved.function.name, resolved.function.arguments)).toBe('sequential');
  });
  test.each([
    { action: 'call', name: 'tool_catalog', arguments: {} },
    { action: 'call', name: 'memory', arguments: [] },
    { action: 'call', name: 'memory' },
    { action: 'delete' }, { action: 'list', offset: -1 },
    { action: 'list', offset: 0.5 }, { action: 'list', query: {} },
  ])('rejects malformed and recursive catalog actions: %j', (args) => {
    expect(() => new LocalToolCatalog(available).resolveCall(catalogCall(args))).toThrow();
  });
  test('bounds pages, descriptions and individual schema output', () => {
    const tools = Array.from({ length: 25 }, (_, i) => tool(`mcp__item_${i}`, 'description'.repeat(100)));
    const catalog = new LocalToolCatalog(tools);
    const first = JSON.parse(catalog.discoveryResult(catalogCall({ action: 'list' }))!.output);
    expect(first.tools).toHaveLength(10); expect(first.nextOffset).toBe(10);
    expect(first.tools[0].description).toHaveLength(160);
    const last = JSON.parse(catalog.discoveryResult(catalogCall({ action: 'list', offset: 20 }))!.output);
    expect(last.tools).toHaveLength(5); expect(last.nextOffset).toBeNull();
    const search = JSON.parse(catalog.discoveryResult(catalogCall({ action: 'list', query: 'ITEM_24' }))!.output);
    expect(search.tools).toHaveLength(1);
    const huge = new LocalToolCatalog([tool('huge', 'x'.repeat(25_000))]);
    expect(huge.discoveryResult(catalogCall({ action: 'describe', name: 'huge' }))?.isError).toBe(true);
  });
  test('respects disabling discovery and rejects a reserved name collision', () => {
    expect(new LocalToolCatalog(available, ['read'], true).tools.map((entry) => entry.function.name)).toEqual(['read']);
    expect(() => new LocalToolCatalog([tool('tool_catalog')])).toThrow('reserved');
  });
  test.each([{}, [''], ['read', 'read'], ['tool_catalog'], Array(10).fill('read'), [123]])('rejects invalid starter configuration: %j', (value) => {
    expect(() => normalizeLocalStarterTools(value, 'tools.localStarterTools')).toThrow('tools.localStarterTools');
  });
});
