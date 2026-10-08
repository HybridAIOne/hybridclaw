export const LATEST_RELEASE_NOTES = {
  version: '0.39.2',
  highlights: [
    'Choose when premium tools spend a boost',
    'Reports and tools in the app Library',
    'Background app tasks keep their replies',
    'Console fonts and log selection fixed',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
