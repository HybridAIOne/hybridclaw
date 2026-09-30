export const LATEST_RELEASE_NOTES = {
  version: '0.33.0',
  highlights: [
    'Phone pairing and push notifications',
    'PDF pages and images reach the model',
    'Publish agent tools to MCP hosts',
    'Ideas, outputs, and safer approvals',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
