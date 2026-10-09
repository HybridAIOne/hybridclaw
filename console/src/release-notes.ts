export const LATEST_RELEASE_NOTES = {
  version: '0.39.5',
  highlights: [
    'Prepare bank transfers as app cards',
    'Messages to named recipients ask first',
    'Twilio voice runs as a bundled plugin',
    'Observability recovers from failing events',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
