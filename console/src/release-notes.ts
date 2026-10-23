export const LATEST_RELEASE_NOTES = {
  version: '0.40.8',
  highlights: [
    'Reliable memory compaction and cleanup',
    'Better prompt-cache reuse',
    'HybridAI without a chatbot',
    'Discord delegate approval buttons',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
