import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const lookupMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

describe('browser SSRF guard', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === 'public.example') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      if (hostname === 'internal.example') {
        return [{ address: '10.0.0.42', family: 4 }];
      }
      return [];
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  test('allows public http and https URLs', async () => {
    const { validateNavigationUrl } = await import(
      '../container/src/browser/ssrf-guard.js'
    );

    await expect(
      validateNavigationUrl('https://public.example/path?q=1'),
    ).resolves.toMatchObject({
      hostname: 'public.example',
      protocol: 'https:',
    });
  });

  test('blocks metadata and private-network destinations', async () => {
    const { validateNavigationUrl } = await import(
      '../container/src/browser/ssrf-guard.js'
    );

    await expect(
      validateNavigationUrl('http://169.254.169.254/latest/meta-data'),
    ).rejects.toThrow(/SSRF guard/i);
    await expect(
      validateNavigationUrl('https://internal.example/dashboard'),
    ).rejects.toThrow(/private address/i);
  });
});
