export const LATEST_RELEASE_NOTES = {
  version: '0.41.5',
  highlights: [
    'Clearer Teams approval requests',
    'Show only available approval choices',
    'View commands and details with 0',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
