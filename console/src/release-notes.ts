export const LATEST_RELEASE_NOTES = {
  version: '0.39.12',
  highlights: [
    'Scheduled runs finish reliably',
    'Daily and Ideas stay out of notifications',
    'Conversation memory saves are verified',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
