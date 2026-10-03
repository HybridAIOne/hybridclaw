export const LATEST_RELEASE_NOTES = {
  version: '0.35.1',
  highlights: [
    'Saved checklists you can tick off',
    'Coaching from on-device movement analysis',
    'YouTube descriptions and fresher connectors',
    'Complete context through compaction',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
