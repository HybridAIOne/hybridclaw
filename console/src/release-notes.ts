export const LATEST_RELEASE_NOTES = {
  version: '0.34.5',
  highlights: [
    'Faster long chats and memory recall',
    'Responsive shell commands and MCP reads',
    'Reset agent files to shipped defaults',
    'Signed webhooks and safer outbound requests',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
