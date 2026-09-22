export const LATEST_RELEASE_NOTES = {
  version: '0.31.1',
  highlights: [
    'Reply in Discord threads',
    'Read forwarded Discord messages',
    'More reliable Teams attachments',
    'Improved A2A interoperability',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
