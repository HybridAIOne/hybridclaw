export const LATEST_RELEASE_NOTES = {
  version: '0.39.9',
  highlights: [
    'Edit email drafts and review approvals in chat',
    'Choose the agent’s model family with /flavour',
    'Import agents without restarting the gateway',
    'Music generation needs no extra send approval',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
