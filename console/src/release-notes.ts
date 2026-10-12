export const LATEST_RELEASE_NOTES = {
  version: '0.39.13',
  highlights: [
    'Mistral model flavour',
    'Scheduled tasks retain their owner',
    'Complete built-in and plugin tool controls',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
