export const LATEST_RELEASE_NOTES = {
  version: '0.38.0',
  highlights: [
    'Reset agents to provisioned defaults',
    'Voice sessions keep your language',
    'Scoped worker credentials',
    'Cloud-ready skill defaults',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
