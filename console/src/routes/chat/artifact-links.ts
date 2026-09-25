/**
 * Artifact links — point markdown links in an assistant reply at the artifacts
 * attached to the same message.
 *
 * Models link deliverables with local paths (`sandbox:/…/list.md`,
 * `/workspace/list.md`) that a browser cannot open and the sanitizer strips.
 * A link whose target basename equals an attached artifact's filename becomes
 * `#artifact-<index>`, and the message block downloads that artifact on click.
 * Web and mail URLs are never rewritten; unmatched local links stay as they are.
 */

import type { ChatArtifact } from '../../api/chat-types';

const ARTIFACT_HREF_PREFIX = '#artifact-';
const MARKDOWN_LINK_TARGET_RE = /\]\(\s*<?([^()\s<>]+)>?\s*\)/g;

function targetBasename(target: string): string {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Keep the raw target when it has malformed percent escapes.
  }
  return decoded.split(/[\\/]/).pop() ?? '';
}

export function linkMarkdownToArtifacts(
  markdown: string,
  artifacts: ChatArtifact[] | undefined,
): string {
  if (!artifacts || artifacts.length === 0) return markdown;
  return markdown.replace(MARKDOWN_LINK_TARGET_RE, (match, target: string) => {
    if (/^(?:https?:|mailto:|#)/i.test(target)) return match;
    const basename = targetBasename(target);
    const index = artifacts.findIndex(
      (artifact) => artifact.path && artifact.filename === basename,
    );
    return index < 0 ? match : `](${ARTIFACT_HREF_PREFIX}${index})`;
  });
}

export function artifactIndexFromHref(href: string | null): number | null {
  if (!href?.startsWith(ARTIFACT_HREF_PREFIX)) return null;
  const index = Number(href.slice(ARTIFACT_HREF_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}
