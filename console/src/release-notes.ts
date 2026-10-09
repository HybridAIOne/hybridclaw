export const LATEST_RELEASE_NOTES = {
  version: '0.39.7',
  highlights: [
    'Side chats with their own memory and connectors',
    'Dashboards and event-triggered tasks',
    'Take over the browser from the Hy app',
    'Receipts, costs and personal data controls',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
