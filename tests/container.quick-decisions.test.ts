import { expect, test } from 'vitest';
import { TOOL_DEFINITIONS, executeToolWithMetadata } from '../container/src/tools.js';

test('the container neither advertises nor executes a chat react tool', async () => {
  expect(TOOL_DEFINITIONS.some(tool => tool.function.name === 'react')).toBe(false);
  const answer = await executeToolWithMetadata('react', '{"emoji":"❤️"}');
  expect(answer.isError).toBe(true);
  expect(answer.output).toContain('Unknown tool');
});
