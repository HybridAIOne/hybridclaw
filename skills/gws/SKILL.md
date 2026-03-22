---
name: gws
description: >-
  Use the Google Workspace CLI (`gws`) for Calendar, Gmail, Drive, Sheets, Docs,
  and Tasks. Trigger this skill whenever the user mentions anything related to
  their Google account: checking calendar, sending email, finding files in Drive,
  reading or editing spreadsheets, creating documents, managing tasks, or any
  cross-service workflow like "prep for my next meeting" or "what's on my plate
  today". Also trigger when the user says "gws", "google workspace", or asks
  about meetings, events, inbox, unread mail, shared docs, or spreadsheets —
  even if they don't explicitly mention Google.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - google
      - workspace
      - calendar
      - gmail
      - drive
      - sheets
      - docs
      - tasks
    related_skills:
      - google-workspace
      - himalaya
    install:
      - kind: npm
        package: "@googleworkspace/cli"
        bins:
          - gws
---

# Google Workspace CLI

This skill uses `gws` — a CLI that talks directly to every Google Workspace API.
It outputs structured JSON, handles auth, and covers Calendar, Gmail, Drive,
Sheets, Docs, Chat, Tasks, Meet, and more.

The reason this is better than browser automation for Google Workspace is that
`gws` gives you structured data, runs in milliseconds, never hits CAPTCHAs or
bot detection, and works headlessly in containers. Browser automation should only
be a last resort for Google services.

## First: check that gws is installed and authenticated

Before running any `gws` command, verify the CLI is available:

```bash
which gws || npm install -g @googleworkspace/cli
```

Then check auth status by running a lightweight command:

```bash
gws calendar +agenda --today 2>&1
```

If this returns an auth error (exit code 2), tell the user:

> You need to authenticate with Google first. Run this in your terminal:
>
> ```
> gws auth login -s calendar,gmail,drive,sheets,docs,tasks
> ```
>
> This opens a browser for Google OAuth. After you sign in, try your request
> again.

If `gws auth login` itself fails because no OAuth client is configured, guide
the user through `gws auth setup` which creates a Cloud project automatically
(requires `gcloud` CLI), or point them to the manual setup in the gws README.

Do not attempt to run `gws auth login` yourself — it requires an interactive
browser session. Just tell the user what to run.

## Be proactive

When the user asks about their calendar, email, files, or tasks — act
immediately. Run the appropriate `gws` command without asking clarifying
questions first. Use sensible defaults:

- Calendar: default to `primary` calendar, current timezone, this week
- Gmail: default to `userId: me`, unread inbox
- Drive: default to listing recent files
- Sheets: if they mention a spreadsheet name, search Drive for it first

Only ask for clarification when genuinely ambiguous — like "which spreadsheet?"
when there are multiple matches, or when creating events that need specific
attendees.

## Helper commands (use these first)

The `+` prefixed commands are concise shortcuts that handle the common cases.
Prefer these over raw API commands.

### Calendar

```bash
# Today's agenda
gws calendar +agenda --today

# Tomorrow
gws calendar +agenda --tomorrow

# This week
gws calendar +agenda --week

# Next N days
gws calendar +agenda --days 7

# Specific calendar
gws calendar +agenda --week --calendar "Work"

# Create an event (always confirm with the user first)
gws calendar +insert \
  --summary "Team standup" \
  --start "2026-03-25T10:00:00" \
  --end "2026-03-25T10:30:00" \
  --location "Room 3A" \
  --description "Weekly sync" \
  --attendee alice@example.com \
  --attendee bob@example.com \
  --meet  # adds a Google Meet link

# Quick add (natural language)
gws calendar events quickAdd \
  --params '{"calendarId": "primary", "text": "Lunch with Alice tomorrow at noon"}'
```

### Gmail

```bash
# Unread inbox summary
gws gmail +triage

# Triage with limit
gws gmail +triage --max 5

# Search
gws gmail +triage --query "from:boss subject:urgent"

# Read a specific message
gws gmail +read --id MESSAGE_ID

# Send email (always confirm with user first)
gws gmail +send \
  --to recipient@example.com \
  --subject "Meeting notes" \
  --body "Here are the notes from today's meeting..." \
  --attach ./notes.pdf

# Reply
gws gmail +reply --message-id MSG_ID --body "Thanks, sounds good."

# Forward
gws gmail +forward --message-id MSG_ID --to someone@example.com
```

### Drive

```bash
# Upload a file
gws drive +upload ./report.pdf --name "Q1 Report" --parent FOLDER_ID

# List recent files
gws drive files list --params '{"pageSize": 10}'

# Search for files
gws drive files list --params '{"q": "name contains '\''budget'\''", "pageSize": 10}'

# Download a file
gws drive files get --params '{"fileId": "FILE_ID", "alt": "media"}' -o ./file.pdf
```

### Sheets

```bash
# Read a range
gws sheets +read --spreadsheet "SPREADSHEET_ID" --range "Sheet1!A1:D10"

# Append rows
gws sheets +append \
  --spreadsheet "SPREADSHEET_ID" \
  --json-values '[["Name", "Score"], ["Alice", 95]]'
```

### Docs

```bash
# Append text to a document
gws docs +write --document "DOC_ID" --text "New section content here"

# Read a document
gws docs documents get --params '{"documentId": "DOC_ID"}'
```

### Workflows (cross-service)

```bash
# Morning briefing: today's meetings + open tasks
gws workflow +standup-report

# Prep for your next meeting: agenda, attendees, linked docs
gws workflow +meeting-prep

# Weekly overview: meetings + unread counts
gws workflow +weekly-digest
```

## Raw API commands (escape hatch)

When helpers don't cover your use case, use the raw Discovery API syntax:

```
gws <service> <resource> <method> --params '{"key": "value"}' --json '{"body": "data"}'
```

All output is JSON by default. Use `--format table` for human-readable output.

To discover what's available:

```bash
gws calendar --help           # list resources
gws schema calendar.events.list  # inspect parameters for a method
```

### Useful raw examples

```bash
# Free/busy query
gws calendar freebusy query \
  --json '{"timeMin": "2026-03-25T00:00:00Z", "timeMax": "2026-03-26T00:00:00Z", "items": [{"id": "primary"}]}'

# List all calendars
gws calendar calendarList list

# Get Gmail labels
gws gmail users labels list --params '{"userId": "me"}'

# Create a spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "Budget Tracker"}}'

# Create a folder in Drive
gws drive files create --json '{"name": "Project Files", "mimeType": "application/vnd.google-apps.folder"}'

# Export a Google Doc as PDF
gws drive files export --params '{"fileId": "DOC_ID", "mimeType": "application/pdf"}' -o ./doc.pdf
```

## Presenting results

Format `gws` JSON output into clean, readable summaries for the user:

- **Calendar events**: group by day, show time + title + location. Flag conflicts.
- **Email triage**: show sender, subject, snippet. Highlight urgent items.
- **Drive files**: show name, type, modified date, sharing status.
- **Sheets data**: render as a Markdown table.

Do not dump raw JSON at the user unless they specifically ask for it.

## Rules

- Never send email or create calendar events without explicit user confirmation.
  Draft the content first and show it to the user for approval.
- If a command fails with exit code 2 (auth error), guide the user through
  `gws auth login` with the appropriate scopes.
- If a command fails with exit code 1 (API error), read the error message and
  adjust — common issues are wrong calendar ID, missing permissions, or quota
  limits.
- Use `--format json` (the default) for programmatic processing, `--format table`
  only when the user wants raw CLI output.
- For shell escaping: wrap JSON in single quotes, use double quotes around
  ranges containing `!` (like `"Sheet1!A1:D10"`).
