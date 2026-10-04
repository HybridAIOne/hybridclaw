export const LATEST_RELEASE_NOTES = {
  version: '0.35.3',
  highlights: [
    'Quick emoji reactions with complete replies',
    'Startup settings for container deployments',
    'Reactions survive failed turns',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
