export const LATEST_RELEASE_NOTES = {
  version: '0.42.1',
  highlights: [
    'Safer PDF reads and rendering recovery',
    'Approval history and delegated file protection',
    'Redacted audit previews by default',
    'Outlook messages and HybridAI transcription',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
