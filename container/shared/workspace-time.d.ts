export function extractUserTimezone(
  content: string | null | undefined,
): string | undefined;
export function currentDateStampInTimezone(
  timezone?: string,
  now?: Date,
): string;
export function nextDateBoundaryInTimezone(timezone?: string, now?: Date): Date;
