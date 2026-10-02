export const LATEST_RELEASE_NOTES = {
  version: '0.34.4',
  highlights: [
    'Reliable chat streams on mobile networks',
    'Faster phone and MCP startup',
    'Phone ratings respect your consent',
    'Auth status for every TUI menu target',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
