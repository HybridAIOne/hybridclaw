export const LATEST_RELEASE_NOTES = {
  version: '0.34.0',
  highlights: [
    'Todos, habits, goals, and check-ins',
    'Phone calls, uploads, and shared data',
    'Live browser frames and checkout approvals',
    'Faster replies and continuous mobile chats',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
