export const LATEST_RELEASE_NOTES = {
  version: '0.39.1',
  highlights: [
    'Import history into another agent',
    'Skip first-run onboarding',
    'Scheduled replies reach the main chat',
    'Agent display names in the console',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
