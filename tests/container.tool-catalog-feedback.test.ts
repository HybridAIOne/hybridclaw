import { expect, test } from 'vitest';
import { ToolCatalog } from '../container/src/tool-catalog.js';

test('schema corrections identify the nested argument failure without echoing values', () => {
  const catalog = new ToolCatalog([{
    type: 'function',
    function: {
      name: 'records_query', description: 'Read a synthetic record.',
      parameters: {
        type: 'object', properties: { verb: { type: 'string' }, payload: { type: 'object' } },
        required: ['verb', 'payload'], additionalProperties: false,
      },
    },
  }], []);
  try {
    catalog.resolveCall({ id: 'bad', type: 'function', function: {
      name: 'tool_catalog',
      arguments: JSON.stringify({ action: 'call', name: 'records_query', verb: 'find', arguments: { key: 'private-input-value' } }),
    } });
    throw new Error('Expected schema rejection');
  } catch (error) {
    const correction = catalog.recoverArgumentError(error);
    expect(correction?.output).toContain('tool_catalog.arguments');
    expect(correction?.output).toContain("required property 'verb'");
    expect(correction?.output).toContain("required property 'payload'");
    expect(correction?.output).not.toContain('private-input-value');
  }
});
