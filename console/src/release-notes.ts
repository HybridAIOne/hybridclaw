export const LATEST_RELEASE_NOTES = {
  version: '0.34.1',
  highlights: [
    'Website sign-ins with protected credentials',
    'Faster browsing and mobile replies',
    'Set your name with /name',
    'Shared phone data survives chat resets',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
