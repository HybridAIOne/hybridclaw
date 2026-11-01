export const LATEST_RELEASE_NOTES = {
  version: '0.42.0',
  highlights: [
    'Learning mode with approval audit flags',
    'Admin approval defaults and safety controls',
    'Safer file writes and interrupted-turn recovery',
    'More reliable web, vision and delegation',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
