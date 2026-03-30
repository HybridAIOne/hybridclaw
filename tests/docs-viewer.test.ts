import { describe, expect, test } from 'vitest';
import {
  buildDocHtmlHref,
  buildDocMarkdownHref,
  parseFrontmatter,
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
    expect(
      buildDocMarkdownHref('README.md', '/docs', '/development'),
    ).toBe('/development/README.md');
    expect(
      buildDocMarkdownHref(
        'extensibility/skills.md',
        '/docs',
        '/development',
      ),
    ).toBe('/development/extensibility/skills.md');
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
