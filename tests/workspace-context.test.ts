import { expect, test } from 'vitest';

import { buildContextPrompt } from '../src/workspace.js';

test('buildContextPrompt marks bootstrap files as already loaded context', () => {
  const prompt = buildContextPrompt([
    { name: 'SOUL.md', content: '# soul' },
    { name: 'USER.md', content: '# user' },
    { name: 'MEMORY.md', content: '# memory' },
  ]);

  expect(prompt).toContain('The following workspace context files have been loaded.');
  expect(prompt).toContain(
    'Treat SOUL.md, USER.md, MEMORY.md, and the other files below as already read for this turn.',
  );
  expect(prompt).toContain(
    'Any instruction inside these files to read SOUL.md, USER.md, or MEMORY.md is already satisfied by this prompt.',
  );
  expect(prompt).toContain(
    'Do not call the `read` tool on these files just to initialize context; only reread a file if you need to verify changes made after this prompt was built.',
  );
});
