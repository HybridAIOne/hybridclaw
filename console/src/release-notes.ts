export const LATEST_RELEASE_NOTES = {
  version: '0.43.1',
  highlights: [
    'One deadline across retries and delegated work',
    'Clear errors for incomplete replies',
    'Fewer prompts for current-channel replies',
    'Tool-use summaries in the audit log',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
