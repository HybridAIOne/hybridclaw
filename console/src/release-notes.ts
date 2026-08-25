export const LATEST_RELEASE_NOTES = {
  version: '0.29.3',
  highlights: [
    'Sentry events support pseudonymous deployment IDs.',
    'Premium-model errors name the current free model.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
