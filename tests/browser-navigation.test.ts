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
  ).rejects.toThrow(/browser\.allowPrivateNetwork/u);
  await expect(
    assertBrowserNavigationUrl('http://127.0.0.1:3000/'),
  ).rejects.not.toThrow(/BROWSER_ALLOW_PRIVATE_NETWORK/u);
});

test.each([
  'http://[::ffff:169.254.169.254]/latest/meta-data/',
  'http://[::ffff:127.0.0.1]:3000/',
  'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
  'http://[::1]:3000/',
  'http://[::]:3000/',
  'http://[::127.0.0.1]/',
  'http://[fd00:ec2::254]/',
  'http://[fe80::1]/',
  'http://[64:ff9b::169.254.169.254]/',
])('browser navigation guard blocks private IPv6 literal %s', async (url) => {
  await expect(assertBrowserNavigationUrl(url)).rejects.toThrow(
    /SSRF guard: private or loopback host/u,
  );
});

test('browser navigation guard accepts public IPv6 literals', async () => {
  await expect(
    assertBrowserNavigationUrl('http://[2606:4700:4700::1111]/'),
  ).resolves.toEqual(new URL('http://[2606:4700:4700::1111]/'));
  await expect(
    assertBrowserNavigationUrl('http://[::ffff:8.8.8.8]/'),
  ).resolves.toEqual(new URL('http://[::ffff:808:808]/'));
});

test('browser navigation guard allows private hosts when explicitly configured', async () => {
  await expect(
    assertBrowserNavigationUrl('http://127.0.0.1:3000/', {
      allowPrivateNetwork: true,
    }),
  ).resolves.toEqual(new URL('http://127.0.0.1:3000/'));
  await expect(
    assertBrowserNavigationUrl('http://[::ffff:127.0.0.1]:3000/', {
      allowPrivateNetwork: true,
    }),
  ).resolves.toEqual(new URL('http://[::ffff:7f00:1]:3000/'));
});

test('browser navigation guard keeps legacy env override as internal fallback', async () => {
  await expect(
    assertBrowserNavigationUrl('http://127.0.0.1:3000/', {
      env: { BROWSER_ALLOW_PRIVATE_NETWORK: 'true' },
    }),
  ).resolves.toEqual(new URL('http://127.0.0.1:3000/'));
});
