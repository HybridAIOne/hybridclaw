export const LATEST_RELEASE_NOTES = {
  version: '0.39.0',
  highlights: [
    'Shared notebook with page history',
    'Hy keeps notes and checklists',
    'Edit scheduled tasks from mobile',
    'Gmail arrivals trigger check-ins',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
