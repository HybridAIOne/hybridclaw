export const LATEST_RELEASE_NOTES = {
  version: '0.32.1',
  highlights: [
    'Reliable file uploads and document delivery',
    'Safer retries and interrupted turns',
    'Enforced monthly agent budgets',
    'Leaner installs with optional media plugins',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
