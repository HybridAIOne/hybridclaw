export const LATEST_RELEASE_NOTES = {
  version: '0.39.3',
  highlights: [
    'Import memory from another assistant',
    'Review email drafts and slide designs',
    'Find savings with approval before cancelling',
    'Phone alerts wait while you use web chat',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
