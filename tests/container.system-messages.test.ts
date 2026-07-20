import { expect, test } from 'vitest';

import { mergeSystemMessage } from '../container/src/system-messages.js';

test('merges volatile instructions into the last system block', () => {
  const messages = mergeSystemMessage(
    [
      { role: 'system', content: 'static core' },
      { role: 'system', content: 'workspace memory' },
      { role: 'system', content: 'skills catalog' },
      { role: 'user', content: 'continue' },
    ],
    '[SkillSelectionCache]\nReuse the selected skill.',
    'last',
  );

  expect(messages).toEqual([
    { role: 'system', content: 'static core' },
    { role: 'system', content: 'workspace memory' },
    {
      role: 'system',
      content:
        'skills catalog\n\n[SkillSelectionCache]\nReuse the selected skill.',
    },
    { role: 'user', content: 'continue' },
  ]);
});
