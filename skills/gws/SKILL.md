---
name: using-gws
description: >-
  Interacts with Google Workspace via the gws CLI for Calendar, Gmail, Drive,
  Sheets, and Docs. Checks calendars, triages email, searches Drive, reads
  spreadsheets, and runs cross-service workflows like morning briefings and
  meeting prep. Triggers on any mention of calendar, meetings, schedule, email,
  inbox, unread mail, Google Drive, spreadsheets, documents, tasks, or requests
  like "what's my day look like" and "morning briefing" — even without
  explicitly mentioning Google.
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
    install:
      - kind: npm
        package: "@googleworkspace/cli"
        bins:
          - gws
---

# Google Workspace via gws CLI

## Step 1: Check auth before anything else

Run `gws auth status` (no API call, instant) and parse the JSON output.
If `auth_method` is `"none"`, tell the user:

> Run `gws auth login` in your terminal to connect your Google account.

That's it. Don't explain OAuth, GCP projects, scopes, or alternatives.
The default login flow works for both personal Gmail and Workspace accounts.

## Step 2: Act immediately

Do not ask clarifying questions. Run the command with sensible defaults:

- Calendar → `primary` calendar, user's timezone
- Gmail → `userId: me`, unread inbox
- Drive → search by name keywords the user mentioned
- Sheets → search Drive first if user gave a name, not an ID

Only ask for clarification when there are genuinely ambiguous results (e.g.,
multiple spreadsheets matching a search).

## Step 3: Pick the right commands

**Calendar**: See [references/calendar.md](references/calendar.md)
**Gmail**: See [references/gmail.md](references/gmail.md)
**Drive & Sheets & Docs**: See [references/drive-docs-sheets.md](references/drive-docs-sheets.md)
**Cross-service workflows**: See [references/workflows.md](references/workflows.md)

For any service not covered above, use `gws <service> --help` to discover
available resources and methods. The raw syntax is:

```
gws <service> <resource> <method> --params '{"key": "val"}' --json '{"body": "data"}'
```

## Confirmation rules

Confirm before actions that **affect other people**:
- Sending email
- Inviting attendees to events
- Sharing files or folders

Do **not** confirm for actions that only affect the user:
- Blocking time on their own calendar
- Creating personal reminders or tasks
- Creating a private document or spreadsheet

The reason: asking "are you sure you want to block 2-4pm?" when the user
just told you to block 2-4pm is friction, not safety.

## Presenting results

Format JSON output into readable summaries. Group calendar events by day.
Show email as sender + subject + snippet. Render sheets data as Markdown
tables. Never dump raw JSON unless the user asks for it.
