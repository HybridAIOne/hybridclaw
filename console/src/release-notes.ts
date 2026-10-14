export const LATEST_RELEASE_NOTES = {
  version: '0.40.1',
  highlights: ['Bug fixes'],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
