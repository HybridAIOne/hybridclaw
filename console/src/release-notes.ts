export const LATEST_RELEASE_NOTES = {
  version: '0.35.0',
  highlights: [
    'Add notes while the agent is working',
    'Receipts for actions outside the sandbox',
    'Phone alerts stay with their app',
    'Faster lookups with complete tool results',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
