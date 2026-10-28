export const LATEST_RELEASE_NOTES = {
  version: '0.41.3',
  highlights: [
    'Overview loads reliably on your phone',
    'Shared reviews stay accessible',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
