export const LATEST_RELEASE_NOTES = {
  version: '0.39.10',
  highlights: [
    'Hy can call your phone',
    'See scheduled runs and failure notices',
    'Generate images without an extra approval',
    'App quick decisions use the default model',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
