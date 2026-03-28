import { expect, test } from 'vitest';

import { buildBrowserLoginArgs } from '../src/browser/browser-login.js';

test('buildBrowserLoginArgs includes automation-compatible profile flags', () => {
  const args = buildBrowserLoginArgs('/tmp/hybridclaw-browser-profile', {
    url: 'https://www.linkedin.com/notifications/',
  });

  expect(args).toContain('--password-store=basic');
  expect(args).toContain('--use-mock-keychain');
  expect(args.at(-1)).toBe('https://www.linkedin.com/notifications/');
});
