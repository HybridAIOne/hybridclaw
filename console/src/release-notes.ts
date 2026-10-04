export const LATEST_RELEASE_NOTES = {
  version: '0.36.1',
  highlights: [
    'Deleted schedules stay deleted',
    'Quieter Discord replies',
    'Phone Markdown editing and reset',
    'Mobile approval and activity details',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
