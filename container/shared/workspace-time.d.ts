export function extractUserTimezone(
  content: string | null | undefined,
): string | undefined;
export function readUserTimezoneFile(userPath: string): string | undefined;
export function resolveEffectiveTimezone(timezone?: string): string;
export function currentDateStampInTimezone(
  timezone?: string,
  now?: Date,
): string;
export function nextDateBoundaryInTimezone(timezone?: string, now?: Date): Date;
