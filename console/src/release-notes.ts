export const LATEST_RELEASE_NOTES = {
  version: '0.43.2',
  highlights: [
    'Browse older messages in web chat',
    'Follow delegated work after reloading chat',
    'Try read-only API turns with dry-run',
    'Answer question cards on supported mobile apps',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
