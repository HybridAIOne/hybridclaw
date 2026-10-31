import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ resetModules: true, unstubAllGlobals: true });

test.each([
  { mode: 'markdown' as const, fallback: false },
  { mode: 'text' as const, fallback: false },
  { mode: 'markdown' as const, fallback: true },
  { mode: 'text' as const, fallback: true },
])(
  'omits commented markup ($mode, fallback: $fallback)',
  async ({ mode, fallback }) => {
    const visible =
      'The visible article describes the observations and the collection method. '.repeat(
        12,
      );
    const html = `<html><head><!-- <title>Discarded title</title> --><title>Field report</title></head><body><article><h1>Field report</h1><p>${visible}</p><!-- <h2>Draft section</h2><a href="/draft">Draft author</a> --><p>Visible ending.</p></article>${fallback ? `<!--${'x'.repeat(1_000_001)}-->` : ''}</body></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(html, { headers: { 'Content-Type': 'text/html' } }),
      ),
    );
    const { webFetch } = await import('../container/src/web-fetch.js');
    const result = await webFetch({
      url: 'https://93.184.216.34/report',
      extractMode: mode,
    });
    expect(result.title).toBe('Field report');
    expect(result.text).toContain('Visible ending.');
    expect(result.text).not.toMatch(
      /Draft section|Draft author|Discarded title|-->/,
    );
  },
);

test.each([
  ['commented script opener', '<!-- <script>discarded -->'],
  ['comment delimiter in script', '<script>const marker = "<!--";</script>'],
  [
    'comment delimiter in attribute',
    '<p data-note="<!--">Visible attribute text.</p>',
  ],
  ['alternate comment ending', '<!-- discarded --!>'],
  ['abrupt empty comment', '<!-->'],
  ['abrupt empty comment with dash', '<!--->'],
])('fallback retains content after %s', async (_name, markup) => {
  const html = `<html><head><title>Field report</title></head><body><p>Visible start.</p>${markup}<p>Visible ending.</p><!--${'x'.repeat(1_000_001)}--></body></html>`;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(html, { headers: { 'Content-Type': 'text/html' } }),
    ),
  );
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: 'https://93.184.216.34/report' });
  expect(result.text).toContain('Visible start.');
  expect(result.text).toContain('Visible ending.');
  expect(result.text).not.toMatch(/discarded|const marker|-->/);
});

test('fallback preserves escaped comment examples and ordinary custom tags', async () => {
  const html = `<html><body><pre>&lt;!-- visible example --&gt;</pre><scripture>Visible custom element.</scripture><!--${'x'.repeat(1_000_001)}--></body></html>`;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(html, { headers: { 'Content-Type': 'text/html' } }),
    ),
  );
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: 'https://93.184.216.34/report' });
  expect(result.text).toContain('<!-- visible example -->');
  expect(result.text).toContain('Visible custom element.');
});

test('fallback discards an unterminated comment through the end of input', async () => {
  const html = `<html><body><p>Visible start.</p><!-- <h2>Unpublished section</h2>${'x'.repeat(1_000_001)}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(html, { headers: { 'Content-Type': 'text/html' } }),
    ),
  );
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: 'https://93.184.216.34/report' });
  expect(result.text).toContain('Visible start.');
  expect(result.text).not.toContain('Unpublished section');
  expect(result.truncated).toBe(false);
});

