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
      buildDocMarkdownHref('extensibility/skills.md', '/docs', '/development'),
    ).toBe('/development/extensibility/skills.md');
  });

  test('exposes remote access in the guides section metadata', () => {
    const guides = DEVELOPMENT_DOCS_SECTIONS.find(
      (section) => section.title === 'Guides',
    );
    expect(
      guides?.pages.some((page) => page.path === 'guides/remote-access.md'),
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

  test('can resolve links against a legacy content base path', () => {
    expect(buildDocMarkdownHref('README.md', '/docs', '/development')).toBe(
      '/development/README.md',
    );
    expect(
      buildDocMarkdownHref('extensibility/skills.md', '/docs', '/development'),
    ).toBe('/development/extensibility/skills.md');
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
