import { expect, test } from 'vitest';

import { TOOL_DEFINITIONS } from '../container/src/tools.js';

test('message tool components schema defines array items', () => {
  const messageTool = TOOL_DEFINITIONS.find(
    (entry) => entry.type === 'function' && entry.function.name === 'message',
  );
  expect(messageTool).toBeDefined();

  const parameters = messageTool?.function.parameters as {
    properties?: Record<string, unknown>;
  };
  const components = (parameters.properties?.components || {}) as {
    type?: unknown;
    items?: unknown;
  };

  expect(Array.isArray(components.type)).toBe(true);
  expect(components.type).toContain('array');
  expect(components.items).toEqual({ type: 'object' });
});
