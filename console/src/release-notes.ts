export const LATEST_RELEASE_NOTES = {
  version: '0.40.4',
  highlights: [
    'Request-log retention and database cleanup',
    'Reliable tool-history transformations',
    'Complete Docker plugin packaging',
    'HybridAI tool-call session attribution',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
