import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders safe markdown links with hardened link attributes', () => {
    expect(renderMarkdown('[HybridClaw](https://example.com/docs)')).toContain(
      '<a href="https://example.com/docs" rel="noopener noreferrer" target="_blank">HybridClaw</a>',
    );
  });

  it('sanitizes common xss payloads', () => {
    const html = renderMarkdown(`
<script>alert("pwned")</script>
<img src="https://evil.test/x" onerror="alert('xss')">
[bad](javascript:alert(1))
<a href="javascript:alert('owned')" onclick="alert('xss')">raw</a>
    `);

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain(
      '<a rel="noopener noreferrer" target="_blank">raw</a>',
    );
  });

  it('escapes dangerous html inside code spans', () => {
    expect(renderMarkdown('`<img src=x onerror=alert(1)>`')).toContain(
      '<code>&lt;img src=x onerror=alert(1)&gt;</code>',
    );
  });

  it('keeps basic markdown structure such as tables and lists', () => {
    const html = renderMarkdown(`
| Name | Value |
| :--- | ---: |
| Alpha | 1 |

- first
- second
    `);

    expect(html).toContain('<table>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>first</li>');
  });

  it('returns empty string for empty or whitespace-only input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  \n')).toBe('');
  });

  it('normalizes CRLF line endings', () => {
    expect(renderMarkdown('line1\r\nline2')).toContain('line1<br />line2');
  });

  it('renders headings h1 through h6', () => {
    expect(renderMarkdown('# A')).toContain('<h1>A</h1>');
    expect(renderMarkdown('## B')).toContain('<h2>B</h2>');
    expect(renderMarkdown('### C')).toContain('<h3>C</h3>');
    expect(renderMarkdown('###### F')).toContain('<h6>F</h6>');
  });

  it('renders inline formatting: bold, italic, code, and GFM strikethrough', () => {
    const html = renderMarkdown('**b** *i* `c` ~~s~~');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>i</em>');
    expect(html).toContain('<code>c</code>');
    expect(html).toContain('<del>s</del>');
  });

  it('converts single newlines into <br /> when breaks is enabled', () => {
    expect(renderMarkdown('line1\nline2')).toContain('line1<br />line2');
  });

  it('renders fenced code blocks with language class intact', () => {
    const html = renderMarkdown('```ts\nconst x = 1;\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('const x = 1;');
  });

  it('renders blockquotes with grouped content', () => {
    const html = renderMarkdown('> line one\n> line two');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('line one');
    expect(html).toContain('line two');
  });

  it('renders horizontal rules between content', () => {
    const html = renderMarkdown('above\n\n---\n\nbelow');
    expect(html).toContain('<hr />');
    expect(html).toContain('above');
    expect(html).toContain('below');
  });

  it('nests ordered and unordered lists via CommonMark indent rules', () => {
    // CommonMark requires child bullets to be indented to the content start
    // of the parent list item: 3+ spaces under "1. ", 2+ spaces under "- ".
    const html = renderMarkdown(
      '1. parent\n   - child\n   - child2\n2. parent2',
    );
    expect(html).toMatch(
      /<ol>\s*<li>parent<ul>\s*<li>child<\/li>\s*<li>child2<\/li>\s*<\/ul>\s*<\/li>\s*<li>parent2<\/li>\s*<\/ol>/,
    );
  });

  it('preserves an explicit ordered-list start marker other than 1', () => {
    const html = renderMarkdown('10. ten\n11. eleven');
    expect(html).toContain('<ol start="10"');
    expect(html).toContain('<li>ten</li>');
  });

  it('renders tables with header, body, and alignment', () => {
    const html = renderMarkdown(
      '| A | B |\n| :--- | ---: |\n| 1 | 2 |\n| 3 | 4 |',
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<th');
    expect(html).toContain('>A</th>');
    expect(html).toContain('<td');
    expect(html).toContain('>1</td>');
    expect(html).toContain('>4</td>');
  });

  it('GFM autolinks bare URLs and hardens the resulting anchor', () => {
    const html = renderMarkdown('Visit https://example.com now');
    expect(html).toContain(
      '<a href="https://example.com" rel="noopener noreferrer" target="_blank">https://example.com</a>',
    );
  });

  it('allows mailto links but strips disallowed schemes like ftp and data', () => {
    expect(renderMarkdown('[mail](mailto:a@b.com)')).toContain(
      'href="mailto:a@b.com"',
    );
    expect(renderMarkdown('[ftp](ftp://x.com)')).not.toContain('href=');
    expect(renderMarkdown('[d](data:text/html,hi)')).not.toContain('href=');
  });

  it('strips <img>, <iframe>, and <style> tags entirely', () => {
    expect(renderMarkdown('![alt](https://x.com/y.png)')).not.toContain('<img');
    expect(renderMarkdown('<iframe src="x"></iframe>after')).not.toContain(
      '<iframe',
    );
    expect(renderMarkdown('<style>body{}</style>after')).not.toContain(
      '<style',
    );
  });

  it('strips event-handler attributes inside allowed tags', () => {
    const html = renderMarkdown(
      '<a href="https://ok.com" onclick="alert(1)">x</a>',
    );
    expect(html).not.toContain('onclick');
  });

  it('issue #320: preserves <ol start="N"> so numbering continues after an interrupting <ul>', () => {
    const html = renderMarkdown(
      '1. First\n- sub\n\n2. Second\n- sub\n\n3. Third',
    );
    expect(html).toContain('<ol start="2"');
    expect(html).toContain('<ol start="3"');
  });

  it('issue #320: treats **N. Heading** lines as ordered list items', () => {
    const html = renderMarkdown('**1. First**\n**2. Second**');
    expect(html).toContain('<ol>');
    expect(html).toContain('<strong>First</strong>');
    expect(html).toContain('<strong>Second</strong>');
    expect(html).not.toContain('<strong>1. First</strong>');
  });

  it('renders a realistic assistant response end-to-end', () => {
    const html = renderMarkdown(
      [
        '# Deploy checklist',
        '',
        'Follow these steps:',
        '',
        '1. Run `npm run build`',
        '2. Tag the release',
        '3. Push to production',
        '',
        '> Remember to notify the team.',
        '',
        '```bash',
        'npm run deploy',
        '```',
        '',
        'See the [runbook](https://example.com/runbook) for recovery.',
      ].join('\n'),
    );
    expect(html).toContain('<h1>Deploy checklist</h1>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>Run <code>npm run build</code></li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre><code class="language-bash">');
    expect(html).toContain(
      '<a href="https://example.com/runbook" rel="noopener noreferrer" target="_blank">runbook</a>',
    );
  });
});
