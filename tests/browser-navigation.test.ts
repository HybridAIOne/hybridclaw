import { expect, test } from 'vitest';

import { assertBrowserNavigationUrl } from '../container/shared/browser-navigation.js';

test('browser navigation guard accepts public web URLs and about:blank', async () => {
  await expect(
    assertBrowserNavigationUrl('https://example.com/docs'),
  ).resolves.toEqual(new URL('https://example.com/docs'));
  await expect(assertBrowserNavigationUrl('about:blank')).resolves.toEqual(
    new URL('about:blank'),
  );
});

test('browser navigation guard blocks unsafe schemes and private hosts by default', async () => {
  await expect(
    assertBrowserNavigationUrl('file:///etc/passwd'),
  ).rejects.toThrow(/Unsupported URL protocol/u);
  await expect(
    assertBrowserNavigationUrl('javascript:alert(1)'),
  ).rejects.toThrow(/Unsupported URL protocol/u);
  await expect(
    assertBrowserNavigationUrl('http://127.0.0.1:3000/'),
  ).rejects.toThrow(/private or loopback host/u);
});

test('browser navigation guard allows private hosts when explicitly configured', async () => {
  await expect(
    assertBrowserNavigationUrl('http://127.0.0.1:3000/', {
      env: { BROWSER_ALLOW_PRIVATE_NETWORK: 'true' },
    }),
  ).resolves.toEqual(new URL('http://127.0.0.1:3000/'));
});
