export const DAILY_MEMORY_MAX_CHARS: number;
export function truncateDailyMemoryText(
  content: string,
  maxChars?: number,
): string;
export function readDailyMemoryFile(filePath: string): string | null;
