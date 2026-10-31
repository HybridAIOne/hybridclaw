import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true, resetModules: true });

const pageUrl = 'https://93.184.216.34/library/chapter/index.html';
const paragraph = 'A detailed reference with links to related material and author information. '.repeat(10);
function page(href: string) {
  return `<html><head><title>Reference</title></head><body><article><h1>Reference</h1><p>${paragraph}<a href="${href}">Related material</a></p><p>${paragraph}</p></article></body></html>`;
}
function response(html: string) {
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

test.each([
  ['/reference?q=one&amp;v=two', 'https://93.184.216.34/reference?q=one&v=two'],
  ['../authors/profile', 'https://93.184.216.34/library/authors/profile'],
  ['?page=2', `${pageUrl}?page=2`],
  ['#details', `${pageUrl}#details`],
  ['//docs.example.com/guide', 'https://docs.example.com/guide'],
  ['https://docs.example.com/start', 'https://docs.example.com/start'],
  ['mailto:hello@example.com', 'mailto:hello@example.com'],
])('HTML link %s has a usable destination', async (href, expected) => {
  const fetch = vi.fn(async () => response(page(href)));
  vi.stubGlobal('fetch', fetch);
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: pageUrl });
  expect(result.text).toContain(`[Related material](${expected})`);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('fallback extraction resolves links without parsing a large document', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(page('../authors/profile') + `<!--${'x'.repeat(1_000_001)}-->`)));
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: pageUrl });
  expect(result.text).toContain('[Related material](https://93.184.216.34/library/authors/profile)');
});

test('relative links use the final URL after a redirect', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: pageUrl } }))
    .mockResolvedValueOnce(response(page('../authors/profile')));
  vi.stubGlobal('fetch', fetch);
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: 'https://93.184.216.34/old' });
  expect(result.text).toContain('[Related material](https://93.184.216.34/library/authors/profile)');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a malformed link does not discard the rest of an article', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(page('http://['))));
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: pageUrl });
  expect(result.text).toContain('Related material');
  expect(result.text).toContain('author information');
});

test('text extraction retains labels without markdown destinations', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(page('../authors/profile'))));
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: pageUrl, extractMode: 'text' });
  expect(result.text).toContain('Related material');
  expect(result.text).not.toContain('](');
});
