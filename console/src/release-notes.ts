export const LATEST_RELEASE_NOTES = {
  version: '0.29.1',
  highlights: [
    'Teams uploads preserve type and stream safely.',
    'Realtime voice selects available credentials.',
    'Idle agents release capacity reliably.',
    'Feedback, pairing QRs, and cloud reads are fixed.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
