export const LATEST_RELEASE_NOTES = {
  version: '0.28.4',
  highlights: [
    'Stable conversation prompt caching.',
    'Refined admin navigation and design.',
    'Guided Microsoft Teams setup.',
    'Security and dependency hardening.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
