export const LATEST_RELEASE_NOTES = {
  version: '0.39.6',
  highlights: [
    'Reconnect to a running chat turn safely',
    'Browser providers run as bundled plugins',
    'Clearer channel setup and upgrade guidance',
    'For you brief edits confirm after saving',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
