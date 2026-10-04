export const LATEST_RELEASE_NOTES = {
  version: '0.36.2',
  highlights: [
    'Explicit mobile decision fallback',
    'Optional emoji chosen by mobile clients',
    'Chat replies keep their text',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
