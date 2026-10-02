export const LATEST_RELEASE_NOTES = {
  version: '0.34.6',
  highlights: [
    'Faster mobile replies and web searches',
    'Shorter app replies with pictures and links',
    'Safer images and link previews',
    'Smaller prompts for large MCP servers',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
