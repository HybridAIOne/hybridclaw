/**
 * Artifact links — point markdown links in an assistant reply at the artifacts
 * attached to the same message.
 *
 * Models link deliverables with local paths (`sandbox:/…/list.md`,
 * `/workspace/list.md`) that a browser cannot open and the sanitizer strips.
 * A link whose target basename equals an attached artifact's filename becomes
 * `#artifact-<index>`, and the message block downloads that artifact on click.
 * Web and mail URLs, links inside code, and unmatched local links are left
 * as they are.
 */

import type { ChatArtifact } from '../../api/chat-types';

const ARTIFACT_HREF_PREFIX = '#artifact-';
const MARKDOWN_LINK_TARGET_RE = /\]\(\s*<?([^()\s<>]+)>?\s*\)/g;
// Capturing split keeps fenced blocks and inline code at odd indexes.
const MARKDOWN_CODE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function findArtifactIndex(artifacts: ChatArtifact[], target: string): number {
  const targetPath = decodeTarget(target).replace(/\\/g, '/');
  const basename = targetPath.split('/').pop() ?? '';
  const matches = artifacts
    .map((artifact, index) => ({ artifact, index }))
    .filter(({ artifact }) => artifact.path && artifact.filename === basename);
  if (matches.length <= 1) return matches[0]?.index ?? -1;
  // Same filename in two directories: prefer the one the link's path names.
  const relativePath = targetPath.replace(
    /^(?:sandbox:|file:\/\/)?(?:\/workspace\/|\.\/)?/,
    '',
  );
  const byPath = matches.find(({ artifact }) =>
    artifact.path?.replace(/\\/g, '/').endsWith(`/${relativePath}`),
  );
  return (byPath ?? matches[0]).index;
}

export function linkMarkdownToArtifacts(
  markdown: string,
  artifacts: ChatArtifact[] | undefined,
): string {
  if (!artifacts || artifacts.length === 0) return markdown;
  return markdown
    .split(MARKDOWN_CODE_RE)
    .map((segment, segmentIndex) =>
      segmentIndex % 2 === 1
        ? segment
        : segment.replace(MARKDOWN_LINK_TARGET_RE, (match, target: string) => {
            if (/^(?:https?:|mailto:|#)/i.test(target)) return match;
            const index = findArtifactIndex(artifacts, target);
            return index < 0 ? match : `](${ARTIFACT_HREF_PREFIX}${index})`;
          }),
    )
    .join('');
}

export function artifactIndexFromHref(href: string | null): number | null {
  if (!href?.startsWith(ARTIFACT_HREF_PREFIX)) return null;
  const index = Number(href.slice(ARTIFACT_HREF_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}
