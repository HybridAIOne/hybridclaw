---
name: apple-calendar
description: Use this skill when the user wants Apple Calendar or iCal workflows on macOS, including viewing schedules, drafting `.ics` files, importing events, or coordinating host-side calendar actions.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - apple
      - calendar
      - ical
      - macos
    related_skills:
      - google-workspace
      - current-time
---

# Apple Calendar

Use this skill for macOS Calendar.app and `.ics` workflows.

## Scope

- draft or import `.ics` files
- review or manage Apple Calendar events on the host Mac
- coordinate one-off calendar actions through the Calendar app or an existing
  local CLI

## Default Strategy

1. Confirm title, date, timezone, and attendees before creating anything.
2. If the task is mostly event creation, prefer a generated `.ics` file that the
   user can import into Calendar.
3. If the user already has a local calendar CLI such as `icalBuddy`, use it for
   read-heavy workflows.
4. For writes in Calendar.app itself, prepare the exact event details first and
   only then trigger the host-side action.

## `.ics` Workflow

Use `.ics` when the user wants a portable calendar event or invite draft.

Minimal event template:

```text
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//HybridClaw//Apple Calendar//EN
BEGIN:VEVENT
UID:example-uid
DTSTAMP:20260314T090000Z
DTSTART:20260318T090000Z
DTEND:20260318T100000Z
SUMMARY:Project Review
DESCRIPTION:Review the release checklist.
LOCATION:Berlin Office
END:VEVENT
END:VCALENDAR
```

After writing the file, import it with:

```bash
open event.ics
```

## Optional Local CLI

If `icalBuddy` is already installed, it is useful for schedule reads:

```bash
icalBuddy eventsToday
icalBuddy eventsFrom:today to:tomorrow
icalBuddy eventsFrom:today to:7days
```

If no calendar CLI exists, fall back to `.ics` generation or direct Calendar app
interaction on the host.

## Working Rules

- Always state the timezone explicitly when the user gives relative times.
- Never send invites or create events with attendees without explicit
  confirmation.
- If recurrence matters, describe it in plain language before encoding it into
  calendar fields.
- Prefer read-before-write when the user is modifying an existing event.
- If the user says "iCal", treat it as Apple Calendar unless they clearly mean a
  raw `.ics` file format workflow.

## Pitfalls

- Do not assume the Mac's timezone matches the event timezone.
- Do not create all-day events when the user gave a specific time.
- Do not turn reminders or todos into calendar events unless the user wants
  scheduling.
