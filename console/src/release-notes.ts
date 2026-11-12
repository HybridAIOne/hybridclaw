export const LATEST_RELEASE_NOTES = {
  version: '0.43.0',
  highlights: [
    'Steer a running web chat',
    'Sign in to websites from chat',
    'Nebius Token Factory models',
    'Voice calls keep chat context',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
