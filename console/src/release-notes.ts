export const LATEST_RELEASE_NOTES = {
  version: '0.29.0',
  highlights: [
    'Realtime voice works on calls and web chat.',
    '/thumbs and Teams reactions capture feedback.',
    'HybridAI defaults to GPT-5.6 Luna.',
    'SQLite shutdown and stale WAL recovery are safer.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
