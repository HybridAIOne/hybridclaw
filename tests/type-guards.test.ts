import { describe, expect, test } from 'vitest';

import { normalizeBaseUrl as n } from '../src/providers/utils.js';
import { ensureText as e } from '../src/skills/skill-import-commons.js';
import { isRecord as r } from '../src/utils/type-guards.js';

describe('type guards and helper functions', () => {
  test('keeps narrow helper behavior explicit', () => {
    expect([{}, null, [], 'string', 0].map(r).join()).toBe(
      'true,false,false,false,false',
    );
    expect(n('')).toBe('');
    expect(n('https://x')).toBe('https://x');
    expect(n(' https://x/// ')).toBe('https://x');
    expect([e('hello'), e(0)]).toEqual(['hello', '']);
  });
});
