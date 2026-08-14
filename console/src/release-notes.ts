export const LATEST_RELEASE_NOTES = {
  version: '0.28.6',
  highlights: [
    'Reliable Teams text, streaming, file delivery.',
    'Agent settings persist with change attribution.',
    'Dependencies ship without known npm advisories.',
    'LINE and WhatsApp install only when enabled.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
