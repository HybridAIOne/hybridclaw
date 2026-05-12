# Calendar Commands

## Helper commands (prefer these)

```bash
gws calendar +agenda --today
gws calendar +agenda --tomorrow
gws calendar +agenda --week
gws calendar +agenda --days 7
gws calendar +agenda --week --calendar "Work"

gws calendar +insert \
  --summary "Team standup" \
  --start "2026-03-25T10:00:00" \
  --end "2026-03-25T10:30:00" \
  --location "Room 3A" \
  --attendee alice@example.com \
  --meet

gws calendar events quickAdd \
  --params '{"calendarId": "primary", "text": "Lunch with Alice tomorrow at noon"}'
```

## Common raw commands

```bash
# Free/busy check
gws calendar freebusy query \
  --json '{"timeMin": "2026-03-25T00:00:00Z", "timeMax": "2026-03-26T00:00:00Z", "items": [{"id": "primary"}]}'

# List all calendars
gws calendar calendarList list

# Delete an event
gws calendar events delete --params '{"calendarId": "primary", "eventId": "EVENT_ID"}'

# Update an event (patch)
gws calendar events patch \
  --params '{"calendarId": "primary", "eventId": "EVENT_ID"}' \
  --json '{"summary": "Updated title"}'
```
