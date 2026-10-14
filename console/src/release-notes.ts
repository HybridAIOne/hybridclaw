export const LATEST_RELEASE_NOTES = {
  version: '0.40.2',
  highlights: [
    'Multilingual voice and text approvals',
    'Health and Contacts privacy protection',
    'Reliable email reassignment',
    'Shared audit logging fixes',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
