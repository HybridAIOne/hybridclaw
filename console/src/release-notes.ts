export const LATEST_RELEASE_NOTES = {
  version: '0.39.4',
  highlights: [
    'Try interactive widgets inside chat',
    'Voice calls continue with chat context',
    'Voice time answers use a fresh clock',
    'Phone calendars cover a full year ahead',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
