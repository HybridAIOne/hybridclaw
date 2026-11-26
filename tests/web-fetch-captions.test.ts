import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true, resetModules: true });

const paragraph = 'The field study records seasonal changes across three survey sites. '.repeat(30);
const article = `<html><head><title>Field study</title></head><body><main><article>
<h1>Field study</h1><p>${paragraph}</p>
<figure><a href="/survey.png"><img src="/survey.png" /></a>
<figcaption>Survey sites: <strong>northern ridge</strong> and southern valley.</figcaption></figure>
<p>${paragraph}</p>
<table><caption>Observations by season</caption><tr><th>Season</th><th>Count</th></tr><tr><td>Spring</td><td>12</td></tr></table>
<p>The final survey is complete.</p>
<script>non-content marker</script>
</article></main></body></html>`;

test.each([
  ['markdown', false],
  ['text', false],
  ['markdown', true],
  ['text', true],
] as const)(
  'retains textual captions in %s with fallback=%s',
  async (extractMode, fallback) => {
    // The oversized comment selects the bounded fallback without changing visible text.
    const html = fallback ? article.replace('<body>', `<body><!--${'x'.repeat(1_000_000)}-->`) : article;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    })));
    const { webFetch } = await import('../container/src/web-fetch.js');
    const result = await webFetch({ url: 'https://93.184.216.34/field-study', extractMode });
    expect(result.text).toContain('Survey sites: northern ridge and southern valley.');
    expect(result.text).toContain('Observations by season');
    expect(result.text).toContain('The final survey is complete.');
    expect(result.text).not.toContain('non-content marker');
    expect(result.text).not.toContain('xxxx');
    expect(result.truncated).toBe(false);
  },
);
