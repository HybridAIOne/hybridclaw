export const LATEST_RELEASE_NOTES = {
  version: '0.28.3',
  highlights: [
    'Encrypted A2A gateway messaging.',
    'Automatic model-tier failover.',
    'Direct OpenAI API support.',
    'Searchable admin settings.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
