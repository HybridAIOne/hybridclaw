export const LATEST_RELEASE_NOTES = {
  version: '0.32.0',
  highlights: [
    'Choose routing modes and privacy boundaries',
    'Sign in to HybridAI with browser or device',
    'Assign Teams users to agents',
    'Inspect cache usage and response costs',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
