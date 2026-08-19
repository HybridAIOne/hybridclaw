export const LATEST_RELEASE_NOTES = {
  version: '0.28.7',
  highlights: [
    'Webchat dictation and read-aloud controls.',
    'Vonage Voice is available as a plugin.',
    'Skills stay discoverable under prompt limits.',
    'BlueBubbles setup errors are actionable.',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
