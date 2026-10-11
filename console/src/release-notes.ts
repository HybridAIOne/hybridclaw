export const LATEST_RELEASE_NOTES = {
  version: '0.39.11',
  highlights: [
    'Back-to-back calls free agent capacity',
    'Large MCP toolsets fit provider limits',
    'Plugin commands explain how to enable them',
    'Observability follows your platform URL',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
