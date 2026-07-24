export const LATEST_RELEASE_NOTES = {
  version: '0.28.5',
  highlights: [
    'Reliable email delivery immediately after setup.',
    'Runtime Python package installation.',
    'Fix Provider API error 500 with GPT models.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
