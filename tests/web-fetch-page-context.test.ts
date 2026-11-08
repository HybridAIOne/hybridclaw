import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true, resetModules: true });

const discussion = 'A detailed discussion of allocation costs, traversal behavior and implementation choices. '.repeat(20);
function page(status: string, landmark = 'main') {
  return `<html><head><title>Change request</title></head><body>
    <${landmark}><div class="page-header"><h1>Change request</h1><span>${status}</span><time>2026-01-10</time></div>
    <nav>Navigation marker</nav><aside>Sidebar marker</aside>
    <div hidden>Hidden marker</div><div aria-hidden="true">Inaccessible marker</div>
    <svg style="display:none"><text>SVG hidden marker</text></svg><div style="display: none">Inline hidden marker</div><div style="display:block">Visible marker</div><div style="visibility: hidden">Invisible marker</div><script>Script marker</script><style>Style marker</style>
    <article><p>${discussion}</p><p>${discussion}</p></article>
    </${landmark}></body></html>`;
}
function serve(html: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { headers: { 'Content-Type': 'text/html' } })));
}

test.each(['markdown', 'text'] as const)('keeps leading page status outside the extracted article in %s', async extractMode => {
  serve(page('Closed without approval'));
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: 'https://93.184.216.34/change', extractMode });
  expect(result.text).toContain('Closed without approval');
  expect(result.text).toContain('2026-01-10');
  expect(result.text).toContain('Visible marker');
  expect(result.text).toContain('allocation costs');
  for (const marker of ['Navigation marker', 'Sidebar marker', 'Hidden marker', 'Inaccessible marker', 'SVG hidden marker', 'Inline hidden marker', 'Invisible marker', 'Script marker', 'Style marker']) {
    expect(result.text).not.toContain(marker);
  }
});

test('preserves status from an ARIA main landmark within the existing output cap', async () => {
  serve(page('Withdrawn').replace('<main>', '<div role="main">').replace('</main>', '</div>'));
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: 'https://93.184.216.34/aria', maxChars: 1000 });
  expect(result.text).toContain('Withdrawn');
  expect(result.text.length).toBeLessThanOrEqual(1000);
  expect(result.truncated).toBe(true);
});

test('does not duplicate leading context already in the article', async () => {
  serve(`<html><head><title>Field guide</title></head><body><main><article><h1>Field guide</h1><p>${discussion}</p><p>${discussion}</p></article></main></body></html>`);
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: 'https://93.184.216.34/guide' });
  expect(result.text).not.toContain('Page context');
  expect(result.text.match(/allocation costs/g)).toHaveLength(40);
});

test.each(['https://127.0.0.1/item', 'https://10.0.0.1/item', 'https://[::1]/item'])('page-context extraction retains SSRF denial for %s', async url => {
  serve(page('Closed'));
  const { webFetch } = await import('../container/src/web-fetch.js');
  await expect(webFetch({ url })).rejects.toThrow(/private|loopback/);
  expect(fetch).not.toHaveBeenCalled();
});


test.each(['hidden', 'aria-hidden="true"', 'style="display:none"'])('skips a hidden main landmark (%s) before the visible one', async hidden => {
  const hiddenPage = page('Hidden status').replace('<main>', `<main ${hidden}>`);
  const visibleMain = page('Active status').match(/<main>[\s\S]*?<\/main>/)![0];
  serve(hiddenPage.replace('</body>', visibleMain + '</body>'));
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: 'https://93.184.216.34/hidden-main' });
  expect(result.text).toContain('Active status');
  expect(result.text).not.toContain('Hidden status');
});

test.each([
  { body: 'Loading content.', shell: '<div id="app"></div>', expected: 'spa_shell_only' },
  { body: 'Verification required. Complete the CAPTCHA to continue. ' + 'Pending application data. '.repeat(20), shell: '', expected: 'bot_blocked' },
])('extra page context preserves $expected', async ({ body, shell, expected }) => {
  serve(`<html><head><title>Service</title></head><body><main><div class="page-header">${'Ancillary account status. '.repeat(3)}</div>${shell}<article><p>${body}</p></article></main></body></html>`);
  const { webFetch } = await import('../container/src/web-fetch.js');
  const result = await webFetch({ url: 'https://93.184.216.34/partial' });
  expect(result.escalationHint).toBe(expected);
  if (expected === 'bot_blocked') expect(result.text.length).toBeGreaterThan(1000);
});
