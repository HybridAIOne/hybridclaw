export const LATEST_RELEASE_NOTES = {
  version: '0.40.3',
  highlights: [
    'Discord sender allowlist',
    'Safer concurrent state-file writes',
    'Consistent integer settings validation',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
