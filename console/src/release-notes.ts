export const LATEST_RELEASE_NOTES = {
  version: '0.34.3',
  highlights: [
    'Set your time zone with /timezone',
    'Reliable goal check-ins and reminders',
    'Grocery links for Knuspr and Gurkerl',
    'Legacy commands removed: see upgrade notes',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
