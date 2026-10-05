export const LATEST_RELEASE_NOTES = {
  version: '0.37.0',
  highlights: [
    'Saved results and lasting goal history',
    'Train connection planning',
    'Faster gateway startup',
    'Recovery from unavailable tools',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
