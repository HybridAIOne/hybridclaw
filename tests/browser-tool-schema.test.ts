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

test('browser_agent_task exposes a plain object schema for structured output', () => {
  const browserAgentTask = BROWSER_TOOL_DEFINITIONS.find(
    (entry) =>
      entry.type === 'function' && entry.function.name === 'browser_agent_task',
  );
  expect(browserAgentTask).toBeDefined();

  const outputSchema = browserAgentTask?.function.parameters.properties
    .output_schema as {
    type?: string | string[];
    anyOf?: unknown;
    oneOf?: unknown;
    allOf?: unknown;
  };
  const artifactPaths = browserAgentTask?.function.parameters.properties
    .artifact_paths as {
    type?: string | string[];
    items?: { type?: string | string[] };
  };

  expect(outputSchema.type).toBe('object');
  expect(outputSchema.anyOf).toBeUndefined();
  expect(outputSchema.oneOf).toBeUndefined();
  expect(outputSchema.allOf).toBeUndefined();
  expect(artifactPaths.type).toBe('array');
  expect(artifactPaths.items?.type).toBe('string');
});

test('browser_get_recording exposes an empty object schema', () => {
  const browserGetRecording = BROWSER_TOOL_DEFINITIONS.find(
    (entry) =>
      entry.type === 'function' &&
      entry.function.name === 'browser_get_recording',
  );
  expect(browserGetRecording).toBeDefined();
  expect(browserGetRecording?.function.parameters).toEqual({
    type: 'object',
    properties: {},
    required: [],
  });
});
