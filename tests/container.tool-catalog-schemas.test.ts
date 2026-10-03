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
    const catalog = ToolCatalog.deferring([target], new Set([target.function.name]), () => false)!;
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
    const catalog = ToolCatalog.deferring([target], new Set([target.function.name]), () => false)!;
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
    const catalog = ToolCatalog.deferring([target], new Set([target.function.name]), () => false)!;
    const result = JSON.parse(catalog.discoveryResult(call('list'))!.output);
    expect(result.tools[0].parameters).toBeUndefined();
    expect(result.tools[0].next.arguments).toEqual({ action: 'describe', name: target.function.name });
    expect(catalog.promptGuidance()).not.toContain(JSON.stringify(schema));
    const described = JSON.parse(catalog.discoveryResult(call('describe', target.function.name))!.output);
    expect(described.function.parameters.properties.arguments).toEqual(schema);
  });

  test('bounds inline schema text across a deferred index and excludes unavailable tools', () => {
    const targets = Array.from({ length: 40 }, (_, i) => tool(`records__lookup_${i}`, { ...parameters, description: 'x'.repeat(1500) }));
    const catalog = ToolCatalog.deferring(targets, new Set(targets.map((entry) => entry.function.name)), () => false)!;
    const schemas = catalog.promptGuidance().split('\n').filter((line) => line.startsWith('  parameters: '));
    expect(schemas.length).toBeGreaterThan(0);
    expect(schemas.length).toBeLessThan(targets.length);
    expect(schemas.reduce((size, line) => size + line.slice('  parameters: '.length).length, 0)).toBeLessThanOrEqual(24_000);
    expect(() => catalog.resolveCall(call('call', 'records__missing', { ids: [1] }))).toThrow('not available');
  });

  test('reserves late names and small schemas before spending the index budget', () => {
    const targets = Array.from({ length: 80 }, (_, i) => tool(`records__lookup_${i}`, { ...parameters, description: 'x'.repeat(1500) }));
    const last = tool('records__small', parameters);
    targets.push(last);
    const catalog = ToolCatalog.deferring(targets, new Set(targets.map((entry) => entry.function.name)), () => false)!;
    const prompt = catalog.promptGuidance();
    expect(prompt).toContain(`- ${last.function.name}(`);
    expect(prompt).toContain(`  parameters: ${JSON.stringify(parameters)}`);
    const entries = prompt.split('\n').filter((line) => line.startsWith('- ') || line.startsWith('  parameters: ')).join('\n');
    expect(entries.length).toBeLessThanOrEqual(24_000);
    expect(entries.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(targets.length);
  });

  test('keeps overflow tools callable when names alone exhaust the index budget', () => {
    const targets = Array.from({ length: 1000 }, (_, i) => tool(`records__lookup_${i}`, parameters));
    const catalog = ToolCatalog.deferring(targets, new Set(targets.map((entry) => entry.function.name)), () => false)!;
    expect(catalog.promptGuidance()).not.toContain('- records__lookup_999(');
    expect(catalog.resolveCall(call('call', 'records__lookup_999', { ids: [1] })).function.name).toBe('records__lookup_999');
    const listed = JSON.parse(catalog.discoveryResult({ id: 'search', type: 'function', function: { name: 'tool_catalog', arguments: JSON.stringify({ action: 'list', query: 'lookup 999' }) } })!.output);
    expect(listed.tools[0].name).toBe('records__lookup_999');
  });

  test('defers bulky built-ins through the same validated catalog without affecting plain requests', () => {
    const small = tool('read', parameters);
    const bulky = tool('http_request', { ...parameters, description: 'x'.repeat(2100) });
    const remote = tool('records__lookup', parameters);
    const catalog = ToolCatalog.deferring([small, bulky, remote], new Set([remote.function.name]), () => false)!;
    expect(catalog.tools.map((entry) => entry.function.name)).toEqual(['read', 'tool_catalog']);
    expect(catalog.resolveCall(call('call', bulky.function.name, { ids: [1] })).function.name).toBe(bulky.function.name);
    expect(() => catalog.resolveCall(call('call', bulky.function.name, { ids: [] }))).toThrow('do not match');
    expect(ToolCatalog.deferring([small, bulky], new Set([remote.function.name]), () => false)).toBeNull();
  });

  test('reserves every deferred name before promoting reviewed read definitions', () => {
    const reads = Array.from({ length: 40 }, (_, i) => tool(`records__read_${i}`, { ...parameters, description: 'x'.repeat(1200) }));
    const mutations = Array.from({ length: 200 }, (_, i) => tool(`records__mutate_${i}`, parameters));
    const all = [...reads, ...mutations];
    const reviewed = new Set(reads.map(entry => entry.function.name));
    const catalog = ToolCatalog.deferring(all, new Set(all.map(entry => entry.function.name)), name => reviewed.has(name))!;
    const exposed = catalog.tools.filter(entry => entry.function.name !== 'tool_catalog');
    const prompt = catalog.promptGuidance();
    const deferred = all.filter(entry => !exposed.includes(entry));
    expect(exposed.length).toBeGreaterThan(0);
    for (const entry of deferred) expect(prompt).toContain(`- ${entry.function.name}(`);
    expect(prompt).not.toMatch(/…and \d+ more/);
    const directory = prompt.split('\n').filter(line => line.startsWith('- ') || line.startsWith('  parameters: ')).join('\n');
    expect(exposed.reduce((size, entry) => size + JSON.stringify(entry).length, 0) + directory.length).toBeLessThanOrEqual(24_000);
  });

  test.each([0, 24_000])('reports the exact omitted name count with a %i-character index budget', (budget) => {
    const targets = Array.from({ length: 1000 }, (_, i) => tool(`records__lookup_${i}`, parameters));
    const catalog = ToolCatalog.deferring(targets, new Set(targets.map(entry => entry.function.name)), () => true)!;
    const internals = catalog as unknown as { indexBudget: number };
    internals.indexBudget = budget;
    const prompt = catalog.promptGuidance();
    const shown = prompt.split('\n').filter(line => line.startsWith('- ')).length;
    expect(shown).toBeLessThan(targets.length);
    expect(Number(/…and (\d+) more/.exec(prompt)![1])).toBe(targets.length - shown);
    if (budget === 0) expect(shown).toBe(0);
    expect(catalog.tools.map(entry => entry.function.name)).toEqual(['tool_catalog']);
  });

  test('exposes only reviewed small reads directly and shares their directory budget', () => {
    const targets = Array.from({ length: 40 }, (_, i) => tool(`records__read_${i}`, { ...parameters, description: 'x'.repeat(1200) }));
    const mutation = tool('records__mutate', parameters);
    const all = [...targets, mutation];
    const deferred = new Set(all.map(entry => entry.function.name));
    const reviewed = new Set(targets.map(entry => entry.function.name));
    const catalog = ToolCatalog.deferring(all, deferred, name => reviewed.has(name))!;
    const exposed = catalog.tools.filter(entry => entry.function.name !== 'tool_catalog');
    expect(exposed.length).toBeGreaterThan(0);
    expect(exposed.length).toBeLessThan(targets.length);
    expect(exposed.every(entry => reviewed.has(entry.function.name))).toBe(true);
    expect(catalog.tools).not.toContainEqual(mutation);
    const directory = catalog.promptGuidance().split('\n').filter(line => line.startsWith('- ') || line.startsWith('  parameters: ')).join('\n');
    expect(exposed.reduce((size, entry) => size + JSON.stringify(entry).length, 0) + directory.length).toBeLessThanOrEqual(24_000);
    expect(ToolCatalog.deferring([...all].reverse(), deferred, name => reviewed.has(name))!.tools).toEqual(catalog.tools);
    expect(catalog.resolveCall(call('call', mutation.function.name, { ids: [1] })).function.name).toBe(mutation.function.name);
    expect(() => catalog.resolveCall(call('call', 'records__blocked', { ids: [1] }))).toThrow('not available');
  });
});
