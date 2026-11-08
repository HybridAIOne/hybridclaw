export const LATEST_RELEASE_NOTES = {
  version: '0.42.2',
  highlights: [
    'Scheduled approvals in chat',
    'Safer interrupted-turn recovery',
    'Agent-scoped API tokens',
    'Git and gh with connected GitHub accounts',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
