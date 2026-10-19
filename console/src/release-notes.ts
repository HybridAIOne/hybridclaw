export const LATEST_RELEASE_NOTES = {
  version: '0.40.5',
  highlights: [
    'Official German public warnings',
    'Realtime voice noise filtering',
    'Accurate voice interruption context',
    'Safer agent identity normalization',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
