import { describe, expect, test } from 'vitest';
import {
  buildDocHtmlHref,
  buildDocMarkdownHref,
  DEVELOPMENT_DOCS_SECTIONS,
  parseFrontmatter,
  renderMarkdownToHtml,
  resolveDocLinkHref,
  resolveDocPathFromPathname,
} from '../docs/static/docs.js';

describe('docs viewer helpers', () => {
  test('maps clean routes to markdown paths', () => {
    expect(resolveDocPathFromPathname('/docs/')).toBe('README.md');
    expect(resolveDocPathFromPathname('/development/')).toBe('README.md');
    expect(resolveDocPathFromPathname('/docs/extensibility/skills')).toBe(
      'extensibility/skills.md',
    );
    expect(resolveDocPathFromPathname('/docs/getting-started/channels')).toBe(
      'channels/overview.md',
    );
    expect(resolveDocPathFromPathname('/docs/internals/runtime')).toBe(
      'developer-guide/runtime.md',
    );
    expect(resolveDocPathFromPathname('/docs/guides/')).toBe(
      'guides/README.md',
    );
  });

  test('builds clean and raw doc hrefs', () => {
    expect(buildDocHtmlHref('README.md')).toBe('/docs/');
    expect(buildDocHtmlHref('guides/README.md')).toBe('/docs/guides/');
    expect(buildDocHtmlHref('extensibility/skills.md')).toBe(
      '/docs/extensibility/skills',
    );
    expect(buildDocMarkdownHref('extensibility/skills.md')).toBe(
      '/docs/extensibility/skills.md',
    );
    expect(
      buildDocMarkdownHref('extensibility/skills.md', '/docs', '/content'),
    ).toBe('/content/extensibility/skills.md');
  });

  test('exposes remote access in the guides section metadata', () => {
    const guides = DEVELOPMENT_DOCS_SECTIONS.find(
      (section) => section.title === 'Guides',
    );
    expect(
      guides?.pages.some((page) => page.path === 'guides/remote-access.md'),
    ).toBe(true);
  });

  test('exposes the new channel IA in the docs section metadata', () => {
    const gettingStarted = DEVELOPMENT_DOCS_SECTIONS.find(
      (section) => section.title === 'Getting Started',
    );
    const channels = DEVELOPMENT_DOCS_SECTIONS.find(
      (section) => section.title === 'Channels',
    );

    expect(
      gettingStarted?.pages.some(
        (page) => page.path === 'getting-started/first-channel.md',
      ),
    ).toBe(true);
    expect(
      channels?.pages.some((page) => page.path === 'channels/overview.md'),
    ).toBe(true);
    expect(
      channels?.pages.some((page) => page.path === 'channels/discord.md'),
    ).toBe(true);
    expect(
      channels?.pages.some((page) => page.path === 'channels/telegram.md'),
    ).toBe(true);
    expect(
      channels?.pages.some((page) => page.path === 'channels/email.md'),
    ).toBe(true);
    expect(
      channels?.pages.some((page) => page.path === 'channels/whatsapp.md'),
    ).toBe(true);
  });

  test('rewrites relative markdown links to browsable canonical docs routes', () => {
    expect(
      resolveDocLinkHref(
        'extensibility/agent-packages.md',
        './skills.md#installing-skills',
      ),
    ).toBe('/docs/extensibility/skills#installing-skills');
    expect(
      resolveDocLinkHref(
        'guides/README.md',
        '../reference/commands.md?plain=1#agent-install',
      ),
    ).toBe('/docs/reference/commands?plain=1#agent-install');
  });

  test('can resolve links against the static published markdown content path', () => {
    expect(buildDocMarkdownHref('README.md', '/docs', '/content')).toBe(
      '/content/README.md',
    );
    expect(
      buildDocMarkdownHref('extensibility/skills.md', '/docs', '/content'),
    ).toBe('/content/extensibility/skills.md');
  });

  test('keeps ordered list items in a single <ol> across blank lines', () => {
    const md = '1. First\n\n2. Second\n\n3. Third';
    const { html } = renderMarkdownToHtml(md);
    const olCount = (html.match(/<ol>/g) || []).length;
    expect(olCount).toBe(1);
    expect(html).toContain('<li>First</li>');
    expect(html).toContain('<li>Second</li>');
    expect(html).toContain('<li>Third</li>');
  });

  test('keeps unordered list items in a single <ul> across blank lines', () => {
    const md = '- Alpha\n\n- Beta\n\n- Gamma';
    const { html } = renderMarkdownToHtml(md);
    const ulCount = (html.match(/<ul>/g) || []).length;
    expect(ulCount).toBe(1);
    expect(html).toContain('<li>Alpha</li>');
    expect(html).toContain('<li>Beta</li>');
    expect(html).toContain('<li>Gamma</li>');
  });

  test('closes a list when non-list content follows a blank line', () => {
    const md = '1. Item\n\nA paragraph.';
    const { html } = renderMarkdownToHtml(md);
    expect(html).toContain('</ol>');
    expect(html).toContain('<p>A paragraph.</p>');
  });

  test('renders tight ordered and unordered lists without blank lines', () => {
    expect(renderMarkdownToHtml('1. a\n2. b\n3. c').html).toBe(
      '<ol><li>a</li><li>b</li><li>c</li></ol>',
    );
    expect(renderMarkdownToHtml('- a\n- b\n- c').html).toBe(
      '<ul><li>a</li><li>b</li><li>c</li></ul>',
    );
  });

  test('normalizes CRLF line endings inside lists', () => {
    const { html } = renderMarkdownToHtml('1. a\r\n2. b\r\n3. c');
    expect(html).toBe('<ol><li>a</li><li>b</li><li>c</li></ol>');
  });

  test('renders headings with anchor links and slug ids', () => {
    const { html, headings } = renderMarkdownToHtml('# First Title\n\n## Sub');
    expect(html).toContain('<h1 id="first-title">');
    expect(html).toContain('<h2 id="sub">');
    expect(html).toContain('href="#first-title"');
    expect(headings).toEqual([
      { level: 1, slug: 'first-title', text: 'First Title' },
      { level: 2, slug: 'sub', text: 'Sub' },
    ]);
  });

  test('de-duplicates repeated heading slugs', () => {
    const { html, headings } = renderMarkdownToHtml('# Setup\n\n# Setup');
    expect(html).toContain('id="setup"');
    expect(html).toContain('id="setup-2"');
    expect(headings.map((h) => h.slug)).toEqual(['setup', 'setup-2']);
  });

  test('renders inline bold, italic, and code', () => {
    const { html } = renderMarkdownToHtml(
      '**bold** and *italic* and `code` plus __alt__ and _alt_',
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<strong>alt</strong>');
    expect(html).toContain('<em>alt</em>');
  });

  test('renders external links with target _blank and rel noopener', () => {
    const { html } = renderMarkdownToHtml('[site](https://example.com)');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>',
    );
  });

  test('rewrites relative doc links and keeps them same-tab', () => {
    const { html } = renderMarkdownToHtml('[skills](./skills.md)', {
      currentDocPath: 'extensibility/agent-packages.md',
    });
    expect(html).toContain('href="/docs/extensibility/skills"');
    expect(html).not.toContain('target="_blank"');
  });

  test('renders fenced code blocks with language class and HTML-escaped body', () => {
    const md = '```ts\nconst x: string = "<y>";\n```';
    const { html } = renderMarkdownToHtml(md);
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('const x: string = &quot;&lt;y&gt;&quot;;');
    expect(html).not.toContain('<y>');
  });

  test('renders markdown tables with header and body rows', () => {
    const { html } = renderMarkdownToHtml(
      'Col A | Col B\n--- | ---\na1 | b1\na2 | b2',
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Col A</th>');
    expect(html).toContain('<th>Col B</th>');
    expect(html).toContain('<td>a1</td>');
    expect(html).toContain('<td>b2</td>');
  });

  test('renders horizontal rules from --- between paragraphs', () => {
    const { html } = renderMarkdownToHtml('before\n\n---\n\nafter');
    expect(html).toContain('<p>before</p>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<p>after</p>');
  });

  test('groups consecutive blockquote lines into one blockquote', () => {
    const { html } = renderMarkdownToHtml('> first\n> second');
    expect(html).toBe('<blockquote><p>first</p><p>second</p></blockquote>');
  });

  test('tags 💡 and 🎯 blockquotes with callout classes', () => {
    expect(renderMarkdownToHtml('> 💡 Tip text').html).toContain(
      '<blockquote class="docs-tip">',
    );
    expect(renderMarkdownToHtml('> 🎯 Try this').html).toContain(
      '<blockquote class="docs-try-it">',
    );
  });

  test('breaks blockquote group when a new callout type begins', () => {
    const md = '> 💡 Tip one\n> details\n\n> 🎯 Try it';
    const { html } = renderMarkdownToHtml(md);
    expect(html).toContain('<blockquote class="docs-tip">');
    expect(html).toContain('<blockquote class="docs-try-it">');
    expect((html.match(/<blockquote/g) || []).length).toBe(2);
  });

  test('escapes raw HTML in paragraph text to prevent injection', () => {
    const { html } = renderMarkdownToHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('returns empty string for empty or whitespace-only input', () => {
    expect(renderMarkdownToHtml('').html).toBe('');
    expect(renderMarkdownToHtml('   \n  \n').html).toBe('');
  });

  // Regression tests for #320 ("<ol> list formatting web chat broken").
  // These cover realistic LLM output patterns: ordered lists interrupted by
  // unordered sub-bullets, indented nested bullets, and bold-wrapped
  // numbered headings ("**1. Heading**").
  test('issue #320: ordered list numbering continues across interrupting <ul>', () => {
    const md = [
      '1. **First question?**',
      '- sub bullet a',
      '- sub bullet b',
      '',
      '2. **Second question?**',
      '- sub bullet c',
      '',
      '3. **Third question?**',
    ].join('\n');
    const { html } = renderMarkdownToHtml(md);
    expect(html).toContain('<ol start="2"');
    expect(html).toContain('<ol start="3"');
  });

  test('issue #320: indented sub-bullets nest inside their parent ordered item', () => {
    const md = '1. parent\n  - child\n  - child2\n2. parent2';
    const { html } = renderMarkdownToHtml(md);
    expect(html).toMatch(
      /<ol><li>parent<ul><li>child<\/li><li>child2<\/li><\/ul><\/li><li>parent2<\/li><\/ol>/,
    );
  });

  test('issue #320: lines like **1. Heading** are recognized as ordered items', () => {
    const md = '**1. First**\n**2. Second**';
    const { html } = renderMarkdownToHtml(md);
    expect(html).toContain('<ol>');
    expect(html).toContain('<li><strong>First</strong></li>');
    expect(html).toContain('<li><strong>Second</strong></li>');
  });

  test('realistic assistant response: headings, lists, code, and callouts render together', () => {
    const md = [
      '# Deploy checklist',
      '',
      'Follow these steps to ship:',
      '',
      '1. Run the build with `npm run build`.',
      '2. Tag the release.',
      '3. Push to production.',
      '',
      '> 💡 Tip: run `npm test` before tagging.',
      '',
      '```bash',
      'npm run deploy',
      '```',
      '',
      'See [the runbook](./remote-access.md) for recovery steps.',
    ].join('\n');
    const { html, headings } = renderMarkdownToHtml(md, {
      currentDocPath: 'guides/README.md',
    });
    expect(headings).toEqual([
      { level: 1, slug: 'deploy-checklist', text: 'Deploy checklist' },
    ]);
    expect(html).toContain('<h1 id="deploy-checklist">');
    expect((html.match(/<ol>/g) || []).length).toBe(1);
    expect(html).toContain(
      '<li>Run the build with <code>npm run build</code>.</li>',
    );
    expect(html).toContain('<li>Tag the release.</li>');
    expect(html).toContain('<li>Push to production.</li>');
    expect(html).toContain('<blockquote class="docs-tip">');
    expect(html).toContain(
      '<pre><code class="language-bash">npm run deploy</code></pre>',
    );
    expect(html).toContain('href="/docs/guides/remote-access"');
  });

  test('parses frontmatter while preserving the markdown body', () => {
    expect(
      parseFrontmatter(
        [
          '---',
          'title: Example Page',
          'description: Example description',
          '---',
          '',
          '# Heading',
          '',
          'Body text.',
        ].join('\n'),
      ),
    ).toEqual({
      metadata: {
        description: 'Example description',
        title: 'Example Page',
      },
      body: '\n# Heading\n\nBody text.',
    });
  });
});
