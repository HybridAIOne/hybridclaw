export const LATEST_RELEASE_NOTES = {
  version: '0.42.4',
  highlights: [
    'Cleaner model picker',
    'Persistent Docker tool settings',
    'Safer file and image handling',
    'Long command output preserved',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
