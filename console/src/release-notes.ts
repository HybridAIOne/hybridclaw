export const LATEST_RELEASE_NOTES = {
  version: '0.42.3',
  highlights: ['Bug fixes'],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
