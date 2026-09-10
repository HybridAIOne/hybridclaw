import { afterEach, expect, test, vi } from 'vitest';
import { currentDateStampInTimezone, extractUserTimezone } from '../container/shared/workspace-time.js';
afterEach(() => vi.unstubAllEnvs());
test('empty timezone does not consume the next USER.md field', () => {
  expect(extractUserTimezone('**Timezone:** \n**Notes:** example')).toBeUndefined();
});
test('blank and invalid user zones use inherited host TZ around midnight', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  const now = new Date('2026-09-08T00:30:00Z');
  expect(currentDateStampInTimezone(undefined, now)).toBe('2026-09-07');
  expect(currentDateStampInTimezone('Invalid/Zone', now)).toBe('2026-09-07');
  expect(currentDateStampInTimezone('Europe/Berlin', now)).toBe('2026-09-08');
});
