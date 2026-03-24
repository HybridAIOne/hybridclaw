const MEDIA_SUMMARY_PREVIEW_LIMIT = 3;

export function summarizeMediaFilenames(filenames: readonly string[]): string {
  if (filenames.length === 0) return '';

  const preview = filenames
    .slice(0, MEDIA_SUMMARY_PREVIEW_LIMIT)
    .map((filename) => String(filename || '').trim())
    .filter(Boolean)
    .join(', ');
  if (filenames.length <= MEDIA_SUMMARY_PREVIEW_LIMIT) {
    return preview;
  }
  return `${preview}, and ${filenames.length - MEDIA_SUMMARY_PREVIEW_LIMIT} more`;
}
