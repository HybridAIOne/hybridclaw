import { expect, test } from 'vitest';

import {
  BROWSER_TOOL_DEFINITIONS,
  getBrowserProviderLogLabel,
  setBrowserGatewayContext,
} from '../container/src/browser-tools.js';

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

test('browser provider log label follows gateway context and defaults to local', () => {
  setBrowserGatewayContext('', '', '', '', '');
  expect(getBrowserProviderLogLabel()).toBe('local');

  setBrowserGatewayContext('', '', 'managed-cloud', 'session-1', 'main');
  expect(getBrowserProviderLogLabel()).toBe('managed-cloud');
  setBrowserGatewayContext('', '', '', '', '');
});
