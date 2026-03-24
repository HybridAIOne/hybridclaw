import { describe, expect, test } from 'vitest';
import {
  buildDocHtmlHref,
  buildDocMarkdownHref,
  parseFrontmatter,
  resolveDocLinkHref,
  resolveDocPathFromPathname,
} from '../docs/static/development-docs.js';

describe('development docs viewer helpers', () => {
  test('maps clean routes to markdown paths', () => {
    expect(resolveDocPathFromPathname('/development/')).toBe('README.md');
    expect(
      resolveDocPathFromPathname('/development/extensibility/skills'),
    ).toBe('extensibility/skills.md');
    expect(resolveDocPathFromPathname('/development/guides/')).toBe(
      'guides/README.md',
    );
  });

  test('builds clean and raw doc hrefs', () => {
    expect(buildDocHtmlHref('README.md')).toBe('/development/');
    expect(buildDocHtmlHref('guides/README.md')).toBe('/development/guides/');
    expect(buildDocHtmlHref('extensibility/skills.md')).toBe(
      '/development/extensibility/skills',
    );
    expect(buildDocMarkdownHref('extensibility/skills.md')).toBe(
      '/development/extensibility/skills.md',
    );
  });

  test('rewrites relative markdown links to browsable docs routes', () => {
    expect(
      resolveDocLinkHref(
        'extensibility/agent-packages.md',
        './skills.md#installing-skills',
      ),
    ).toBe('/development/extensibility/skills#installing-skills');
    expect(
      resolveDocLinkHref(
        'guides/README.md',
        '../reference/commands.md?plain=1#agent-install',
      ),
    ).toBe('/development/reference/commands?plain=1#agent-install');
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
