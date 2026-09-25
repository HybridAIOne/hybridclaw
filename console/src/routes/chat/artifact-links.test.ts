import { describe, expect, it } from 'vitest';
import {
  artifactIndexFromHref,
  linkMarkdownToArtifacts,
} from './artifact-links';

const artifacts = [
  { filename: 'shot.png', path: '/ws/.browser-artifacts/shot.png' },
  { filename: 'list.md', path: '/ws/list.md', mimeType: 'text/markdown' },
];

describe('linkMarkdownToArtifacts', () => {
  it.each([
    ['sandbox:/Users/me/workspace/list.md'],
    ['/workspace/list.md'],
    ['list.md'],
    ['file:///Users/me/workspace/list.md'],
  ])('points a local link to %s at the attached artifact', (target) => {
    expect(linkMarkdownToArtifacts(`See [Liste](${target}).`, artifacts)).toBe(
      'See [Liste](#artifact-1).',
    );
  });

  it.each([
    ['https://example.com/list.md'],
    ['sandbox:/Users/me/workspace/other.md'],
  ])('leaves %s untouched', (target) => {
    const markdown = `See [Liste](${target}).`;
    expect(linkMarkdownToArtifacts(markdown, artifacts)).toBe(markdown);
  });

  it('leaves text untouched without artifacts', () => {
    expect(linkMarkdownToArtifacts('[a](list.md)', undefined)).toBe(
      '[a](list.md)',
    );
  });
});

describe('artifactIndexFromHref', () => {
  it.each([
    ['#artifact-1', 1],
    ['#artifact-x', null],
    ['https://example.com', null],
    [null, null],
  ])('parses %s', (href, expected) => {
    expect(artifactIndexFromHref(href)).toBe(expected);
  });
});
