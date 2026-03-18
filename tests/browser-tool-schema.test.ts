import { expect, test } from 'vitest';

import { BROWSER_TOOL_DEFINITIONS } from '../container/src/browser-tools.js';

test('browser_click schema requires at least one targeting field', () => {
  const browserClick = BROWSER_TOOL_DEFINITIONS.find(
    (entry) =>
      entry.type === 'function' && entry.function.name === 'browser_click',
  );
  expect(browserClick).toBeDefined();

  const parameters = browserClick?.function.parameters as {
    anyOf?: Array<{ required?: string[] }>;
    required?: string[];
  };

  expect(parameters.required).toEqual([]);
  expect(parameters.anyOf).toEqual([
    { required: ['ref'] },
    { required: ['selector'] },
    { required: ['text'] },
  ]);
});
