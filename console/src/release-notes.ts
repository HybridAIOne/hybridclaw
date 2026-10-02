export const LATEST_RELEASE_NOTES = {
  version: '0.34.2',
  highlights: [
    'Chat reactions and thumbs-up/down ratings',
    'App links for food, trains, and hotels',
    'Quieter scheduled replies',
    'More reliable browsing and send approvals',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
