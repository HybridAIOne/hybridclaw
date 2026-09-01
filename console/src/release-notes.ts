export const LATEST_RELEASE_NOTES = {
  version: '0.30.0',
  highlights: [
    'Configure agents in the console',
    'Install plugins from the console',
    'Manage multiple chat sessions',
    'Configure realtime speech everywhere',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
