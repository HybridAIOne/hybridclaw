# Cross-Service Workflows

## Built-in workflows

```bash
# Morning briefing: today's meetings + open tasks
gws workflow +standup-report

# Prep for next meeting: agenda, attendees, linked docs
gws workflow +meeting-prep

# Weekly overview: meetings + unread counts
gws workflow +weekly-digest

# Convert email to task
gws workflow +email-to-task

# Announce a file in Chat
gws workflow +file-announce
```

## Manual multi-step patterns

When a built-in workflow doesn't fit, chain commands. Examples:

**"Check email then schedule with important senders":**
1. `gws gmail +triage` → get unread emails
2. Pick the important senders from the results
3. `gws calendar +insert --summary "..." --attendee sender@...` → create event (confirm with user first since it involves attendees)

**"Find a spreadsheet and extract data":**
1. `gws drive files list --params '{"q": "name contains '\''sales'\''..."}'` → find the file
2. `gws sheets +read --spreadsheet "ID" --range "Sheet1!A1:Z100"` → read the data
3. Present the relevant numbers to the user

**"Block time and reschedule a conflict":**
1. `gws calendar +agenda --today` → find existing events
2. `gws calendar +insert --summary "Deep Work" --start ... --end ...` → create the block (no confirmation needed for personal blocks)
3. `gws calendar events patch --params '{"calendarId": "primary", "eventId": "..."}' --json '{"start": ..., "end": ...}'` → move the conflicting event
