export const LATEST_RELEASE_NOTES = {
  version: '0.41.2',
  highlights: [
    'Keep email proposals as mailbox drafts',
    'Chat ideas shaped by your skills and tools',
    'Phone data available from the first message',
    'Better tool availability and failure recovery',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
