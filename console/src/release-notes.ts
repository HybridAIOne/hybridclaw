export const LATEST_RELEASE_NOTES = {
  version: '0.29.2',
  highlights: [
    'Web apps can start secure realtime voice.',
    'Signal linking persists and clears stale QRs.',
    'Teams sends find canonical conversations.',
    'Desktop and HTML dependencies are hardened.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
