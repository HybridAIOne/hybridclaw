export const LATEST_RELEASE_NOTES = {
  version: '0.36.0',
  highlights: [
    'Preferences shared across chats and schedules',
    'Saved evidence for background suggestions',
    'Memory views for people and groups',
    'Dream journals show memory changes',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
