export const TEXT_FILE_TRUNCATION_MARKER: string;
export function readTextFileHeadTail(
  filePath: string,
  maxBytes: number,
): string | null;
