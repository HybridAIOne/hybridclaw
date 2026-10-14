/**
 * A known calendar-create contract distinguishes a personal entry from an
 * invitation. Unknown tools, targets and sharing arguments keep normal policy;
 * this is argument validation, not an inference from the user's wording.
 */
export function isPersonalCalendarCreate(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  // Owner request, 2026-10-14: a primary-calendar entry without guests or
  // notifications is an ordinary reversible write. Other calendars stay gated.
  if (
    toolName !== 'hybridai__google_workspace__create_event' ||
    args.calendar_id !== 'primary' ||
    args.send_updates !== 'none'
  )
    return false;
  if (
    args.attendees !== undefined &&
    (!Array.isArray(args.attendees) || args.attendees.length !== 0)
  )
    return false;
  const fields = new Set([
    'calendar_id',
    'summary',
    'description',
    'location',
    'start',
    'end',
    'time_zone',
    'send_updates',
    'attendees',
  ]);
  return Object.keys(args).every((key) => fields.has(key));
}
