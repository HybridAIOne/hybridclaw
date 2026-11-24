export const LATEST_RELEASE_NOTES = {
  version: '0.44.1',
  highlights: [
    'Manage personal agents in Teams settings',
    'Choose a supported HybridAI reasoning level',
    'Run headed Chrome in hosted sandboxes',
    'Receive scheduled reports directly in web chat',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
