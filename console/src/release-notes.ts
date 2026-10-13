export const LATEST_RELEASE_NOTES = {
  version: '0.40.0',
  highlights: [
    'Bind channels to their agent',
    'Give each agent its own mailbox',
    'Review connector changes in chat',
    'Lighter runtime packages',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
