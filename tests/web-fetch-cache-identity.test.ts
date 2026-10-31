import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ resetModules: true, unstubAllGlobals: true });

test.each([
  ['/Report.txt', '/report.txt'],
  ['/report?Item=one', '/report?item=one'],
  ['/report?item=PageA', '/report?item=pagea'],
])(
  'case-distinct URLs keep separate cache entries: %s / %s',
  async (firstPath, secondPath) => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request) =>
        new Response(`Document at ${String(url)}`, {
          headers: { 'Content-Type': 'text/plain' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { webFetch } = await import('../container/src/web-fetch.js');
    const firstUrl = `https://93.184.216.34${firstPath}`;
    const secondUrl = `https://93.184.216.34${secondPath}`;
    const first = await webFetch({ url: firstUrl });
    const second = await webFetch({ url: secondUrl });
    const repeated = await webFetch({ url: firstUrl });
    expect(first).toMatchObject({
      url: firstUrl,
      text: `Document at ${firstUrl}`,
    });
    expect(second).toMatchObject({
      url: secondUrl,
      text: `Document at ${secondUrl}`,
    });
    expect(second.cached).not.toBe(true);
    expect(repeated).toMatchObject({ ...first, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);
