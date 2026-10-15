import { expect, test, vi } from 'vitest';

import { BUILTIN_TOOLS } from '#shared/builtin-tools.js';

test('the built-in tool manifest lists every container tool definition exactly once', async () => {
  vi.resetModules();
  const { TOOL_DEFINITIONS } = await import('../container/src/tools.js');
  const defined = TOOL_DEFINITIONS.map((tool) => tool.function.name);
  const listed = BUILTIN_TOOLS.map((tool) => tool.name);

  expect(new Set(listed).size).toBe(listed.length);
  expect([...listed].sort()).toEqual([...defined].sort());
});
