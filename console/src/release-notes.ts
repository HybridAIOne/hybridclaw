export const LATEST_RELEASE_NOTES = {
  version: '0.28.6',
  highlights: [
    'Live Microsoft Teams activity and streaming.',
    'Openable files in Teams direct messages.',
    'Reliable cloud admin reauthentication.',
    'LINE and WhatsApp remain install-on-demand.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
