export const LATEST_RELEASE_NOTES = {
  version: '0.28.6',
  highlights: [
    'Live Microsoft Teams activity and streaming.',
    'Openable generated files in Teams direct messages.',
    'WhatsApp remains strictly install-on-demand.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
