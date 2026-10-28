export const LATEST_RELEASE_NOTES = {
  version: '0.41.4',
  highlights: [
    'Check prepared work before review',
    'Keep repair history and retry limits',
    'Require evidence before goals finish',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
