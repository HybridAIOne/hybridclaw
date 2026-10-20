export const LATEST_RELEASE_NOTES = {
  version: '0.40.6',
  highlights: [
    'Scheduled-job failure notices',
    'Personal agents follow parent instructions',
    'Clearer Teams attachment errors',
    'Cleaner error tracking',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
