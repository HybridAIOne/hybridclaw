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
function catalogCall(args: Record<string, unknown>): ToolCall { return call('tool_catalog', { ...(args.action === 'list' ? { name: '' } : {}), ...args }); }
const available = [...DEFAULT_LOCAL_STARTER_TOOLS.map((name) => tool(name)), tool('memory'), tool('mcp__lookup')];

describe('local tool catalog boundary', () => {
  test('offers nine starters plus discovery without growing model definitions', () => {
    const catalog = new LocalToolCatalog(available);
    const before = JSON.stringify(catalog.tools);
    expect(catalog.tools).toHaveLength(10);
    expect(catalog.tools.find((entry) => entry.function.name === 'tool_catalog')?.function.parameters.required).toEqual(['action', 'name']);
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
    for (const request of [catalogCall({ action: 'call', name: 'bash', arguments: {} }), call('bash', {})]) expect(() => catalog.resolveCall(request)).toThrow('not available');
    const missing = catalog.discoveryResult(catalogCall({ action: 'describe', name: 'bash' }));
    expect(missing?.isError).toBe(true);
    expect(missing?.output).not.toContain('parameters');
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
    expect(search.tools[0].name).toBe('mcp__item_24');
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


test('prompt guidance reflects actual exposed schemas without granting hidden tools', () => {
  const available = [tool('read'), tool('skills_list'), tool('bash')];
  const compact = new LocalToolCatalog(available, ['skills_list']);
  const prompt = compact.promptGuidance();
  expect(prompt).toContain('functions in this request are skills_list and tool_catalog.');
  expect(prompt).toContain('Never emit a direct read call');
  expect(prompt).toContain('Never emit a direct bash call');
  expect(prompt).toContain('"action":"call","name":"bash","arguments":{"command":');
  expect(prompt).toContain('"action":"describe","name":"read"');
  expect(prompt).toContain('unavailable or blocked');
  expect(compact.promptGuidance()).toBe(prompt);
  const direct = new LocalToolCatalog(available, ['read']);
  expect(direct.promptGuidance()).not.toContain('Never emit a direct read call');
  const noDiscovery = new LocalToolCatalog(available, ['skills_list'], true);
  expect(noDiscovery.promptGuidance()).toContain('Tool discovery is not exposed');
  expect(noDiscovery.promptGuidance()).not.toContain('call tool_catalog');
  expect(new LocalToolCatalog([tool('skills_list')], []).promptGuidance()).not.toContain('name":"bash');
  expect(new LocalToolCatalog([]).promptGuidance()).toContain('No functions are exposed');
});


test('returns corrective lookup errors without echoing unknown names or restoring tools', () => {
  const catalog = new LocalToolCatalog([tool('read'), tool('skills_list')], ['skills_list']);
  const schemas = JSON.stringify(catalog.tools);
  const missing = catalogCall({ action: 'describe', name: 'sensitive-placeholder' });
  expect(catalog.resolveCall(missing)).toBe(missing);
  const result = catalog.discoveryResult(missing);
  expect(result).toMatchObject({ isError: true, output: expect.stringContaining('Skill names and file paths are not tool names') });
  expect(result?.output).toContain('describe the tool named read');
  expect(result?.output).not.toContain('sensitive-placeholder');
  expect(catalog.discoveryResult(catalogCall({ action: 'describe', name: 'read' }))?.isError).toBe(false);
  catalog.discoveryResult(missing);
  expect(() => catalog.resolveCall(missing)).toThrow('not available');
  expect(catalog.discoveryResult(catalogCall({ action: 'describe', name: 'read' }))?.isError).toBe(false);
  expect(JSON.stringify(catalog.tools)).toBe(schemas);
  expect(() => catalog.resolveCall(catalogCall({ action: 'call', name: 'pdf', arguments: {} }))).toThrow('not available');
  const noRead = new LocalToolCatalog([tool('memory')], []);
  expect(noRead.discoveryResult(missing)?.output).not.toContain('tool named read');
});


test('describes the exact catalog invocation without exposing another function', () => {
  const read = tool('read', 'Read a file.');
  read.function.parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const catalog = new LocalToolCatalog([read], []);
  const before = JSON.stringify(catalog.tools);
  const result = JSON.parse(catalog.discoveryResult(catalogCall({ action: 'describe', name: 'read' }))!.output);
  expect(result.function.name).toBe('tool_catalog');
  expect(result.function.parameters.properties.action.enum).toEqual(['call']);
  expect(result.function.parameters.properties.name.enum).toEqual(['read']);
  expect(result.function.parameters.properties.arguments).toEqual(read.function.parameters);
  expect(result.function.parameters.required).toEqual(['action', 'name', 'arguments']);
  expect(JSON.stringify(catalog.tools)).toBe(before);
});


test('only malformed catalog call fields can receive bounded correction', () => {
  const catalog = new LocalToolCatalog(available, ['skills_list']);
  for (const args of [{ action: 'call', arguments: { path: 'notes.txt' } }, { action: 'call', name: 'read' }]) {
    try { catalog.resolveCall(catalogCall(args)); throw new Error('Expected validation failure'); }
    catch (error) { expect(catalog.recoverArgumentError(error)).toMatchObject({ isError: true, output: expect.stringContaining('No tool in this batch was executed') }); }
  }
  try { catalog.resolveCall(catalogCall({ action: 'call' })); }
  catch (error) { expect(catalog.recoverArgumentError(error)).toBeNull(); }
  expect(catalog.recoverArgumentError(new Error('sensitive-placeholder'))).toBeNull();
  const restricted = new LocalToolCatalog([tool('skills_list')], []);
  try { restricted.resolveCall(catalogCall({ action: 'call', name: 'read', arguments: {} })); }
  catch (error) { expect(restricted.recoverArgumentError(error)).toBeNull(); }
});


test('requires the catalog name field even when listing tools', () => {
  const catalog = new LocalToolCatalog(available);
  const invalid = call('tool_catalog', { action: 'list' });
  expect(() => catalog.resolveCall(invalid)).toThrow('top-level name');
  expect(catalog.discoveryResult(catalogCall({ action: 'list' }))?.isError).toBe(false);
});


test('ranks multiword capabilities and parameter names, with an explicit schema step', () => {
  const lookup = tool('mcp__calendar_search', 'Find scheduled events.');
  lookup.function.parameters = { type: 'object', properties: { attendee_email: { type: 'string' } }, required: ['attendee_email'] };
  const catalog = new LocalToolCatalog([lookup, tool('mcp__files_search', 'Find files.'), tool('mcp__pdf_create', 'Create PDF files.')], []);
  const page = JSON.parse(catalog.discoveryResult(catalogCall({ action: 'list', query: 'create PDF' }))!.output);
  expect(page.tools[0]).toMatchObject({ name: 'mcp__pdf_create', next: { name: 'tool_catalog', arguments: { action: 'describe', name: 'mcp__pdf_create' } } });
  const byParameter = JSON.parse(catalog.discoveryResult(catalogCall({ action: 'list', query: 'attendee email' }))!.output);
  expect(byParameter.tools[0].name).toBe(lookup.function.name);
  expect(byParameter.tools[0].required).toEqual(['attendee_email']);
  expect(JSON.stringify(byParameter)).not.toContain('parameters');
  const empty = JSON.parse(catalog.discoveryResult(catalogCall({ action: 'list', query: 'absent' }))!.output);
  expect(empty).toMatchObject({ tools: [], total: 0, availableCount: 3 });
  expect(empty.hint).toContain('fewer keywords');
});

test('validates nested arguments before resolving an action without coercion or payload echoes', () => {
  const target = tool('target');
  target.function.parameters = { type: 'object', properties: { command: { type: 'string' }, options: { type: 'object', properties: { mode: { type: 'string', enum: ['safe'] } }, required: ['mode'] } }, required: ['command', 'options'], additionalProperties: false };
  for (const args of [{ path: 'private-placeholder' }, { command: 123, options: { mode: 'safe' } }, { command: 'pwd', options: { mode: 'wrong' } }]) {
    const catalog = new LocalToolCatalog([target], []);
    try { catalog.resolveCall(catalogCall({ action: 'call', name: 'target', arguments: args })); throw new Error('Expected rejection'); }
    catch (error) {
      const correction = catalog.recoverArgumentError(error);
      expect(correction?.output).toContain('Arguments do not match');
      expect(correction?.output).not.toContain('private-placeholder');
    }
  }
  const args = { command: 'pwd', options: { mode: 'safe' } };
  const original = catalogCall({ action: 'call', name: 'target', arguments: args });
  expect(new LocalToolCatalog([target], []).resolveCall(original).function.arguments).toBe(JSON.stringify(args));
  expect(original.function.name).toBe('tool_catalog');
});

test('isolates schema ids and refuses schemas requiring external resolution', () => {
  const a = tool('one'); const b = tool('two');
  Object.assign(a.function.parameters, { $id: 'https://example.com/shared', required: ['a'] });
  Object.assign(b.function.parameters, { $id: 'https://example.com/shared', required: ['b'] });
  const catalog = new LocalToolCatalog([a, b], []);
  expect(catalog.resolveCall(catalogCall({ action: 'call', name: 'one', arguments: { a: true } })).function.name).toBe('one');
  expect(() => catalog.resolveCall(catalogCall({ action: 'call', name: 'two', arguments: { a: true } }))).toThrow('do not match');
  expect(catalog.resolveCall(catalogCall({ action: 'call', name: 'two', arguments: { b: true } })).function.name).toBe('two');
  const external = tool('external'); Object.assign(external.function.parameters, { $ref: 'https://example.com/missing' });
  const blocked = new LocalToolCatalog([external], []);
  try { blocked.resolveCall(catalogCall({ action: 'call', name: 'external', arguments: {} })); throw new Error('Expected rejection'); }
  catch (error) { expect(String(error)).toContain('cannot be validated'); expect(blocked.recoverArgumentError(error)).toBeNull(); }
});
