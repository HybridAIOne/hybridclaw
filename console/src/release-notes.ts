export const LATEST_RELEASE_NOTES = {
  version: '0.35.2',
  highlights: [
    'Goals prepare work before checking in',
    'Proactive checks on connector changes',
    'Fresh phone data for scheduled work',
    'Mini-skill cards and contextual reactions',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
