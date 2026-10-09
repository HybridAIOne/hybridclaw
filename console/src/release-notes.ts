export const LATEST_RELEASE_NOTES = {
  version: '0.39.8',
  highlights: ['Phone todos and goals load reliably'],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
