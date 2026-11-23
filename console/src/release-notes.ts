export const LATEST_RELEASE_NOTES = {
  version: '0.44.0',
  highlights: [
    'Enter checkout details directly in web chat',
    'Choose the sending account for email',
    'Manage German district warnings in Hy',
    'Review the full command before approving shell access',
  ],
} as const;

export function getReleaseHighlights(version: string): readonly string[] {
  return version === LATEST_RELEASE_NOTES.version
    ? LATEST_RELEASE_NOTES.highlights
    : [];
}
