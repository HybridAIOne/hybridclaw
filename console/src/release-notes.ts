export const LATEST_RELEASE_NOTES = {
  version: '0.41.0',
  highlights: [
    'Daily briefs on your schedule',
    'Persistent follow-through and draft reviews',
    'Run JavaScript in browser pages',
    'Telemetry without a chatbot',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
