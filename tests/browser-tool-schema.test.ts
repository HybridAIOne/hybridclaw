import { expect, test } from 'vitest';

import { BROWSER_TOOL_DEFINITIONS } from '../container/src/browser-tools.js';

test('browser_click schema avoids unsupported top-level combinators', () => {
  const browserClick = BROWSER_TOOL_DEFINITIONS.find(
    (entry) =>
      entry.type === 'function' && entry.function.name === 'browser_click',
  );
  expect(browserClick).toBeDefined();

  const parameters = browserClick?.function.parameters as {
    anyOf?: unknown;
    oneOf?: unknown;
    allOf?: unknown;
    not?: unknown;
    required?: string[];
  };

  expect(parameters.required).toEqual([]);
  expect(parameters.anyOf).toBeUndefined();
  expect(parameters.oneOf).toBeUndefined();
  expect(parameters.allOf).toBeUndefined();
  expect(parameters.not).toBeUndefined();
});
