export const LATEST_RELEASE_NOTES = {
  version: '0.30.1',
  highlights: [
    'See memory recall across channels',
    'Keep agent actions and confirmations honest',
    'Schedule recurring tasks reliably',
    'Control inbound voice callers',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
