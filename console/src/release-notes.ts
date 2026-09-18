export const LATEST_RELEASE_NOTES = {
  version: '0.31.0',
  highlights: [
    'Run local models on your Mac',
    'Choose starter tools and skills',
    'Keep tool history across turns',
    'Schedule tasks in your timezone',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
