export const LATEST_RELEASE_NOTES = {
  version: '0.41.1',
  highlights: [
    'Shared HybridAI knowledge and wikis',
    'Optional nightly wiki maintenance',
    'Cleaner reminders and working event triggers',
    'Requires Node 22.23.4 or later in Node 22',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
