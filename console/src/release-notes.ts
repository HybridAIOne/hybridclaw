export const LATEST_RELEASE_NOTES = {
  version: '0.40.7',
  highlights: [
    'Live Discord delegate progress',
    'Readable tables across messages',
    'Voice call end diagnostics',
    'Updated image TLS trust',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
