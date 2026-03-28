import { expect, test } from 'vitest';

import { buildOptionalAgentPresentation } from '../src/agents/agent-types.js';

test('buildOptionalAgentPresentation includes only populated presentation fields', () => {
  expect(buildOptionalAgentPresentation('Charly', 'avatars/charly.png')).toEqual(
    {
      displayName: 'Charly',
      imageAsset: 'avatars/charly.png',
    },
  );
  expect(buildOptionalAgentPresentation('', '')).toEqual({});
  expect(buildOptionalAgentPresentation(undefined, 'avatars/charly.png')).toEqual(
    {
      imageAsset: 'avatars/charly.png',
    },
  );
});
