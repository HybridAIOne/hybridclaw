---
name: gws
description: Use the gws CLI for Google Calendar, Gmail, Drive, Sheets, Docs, Tasks, and cross-service Workspace workflows.
user-invocable: true
metadata:
  hybridclaw:
    category: productivity
    short_description: "Google Workspace via gws CLI."
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
      - id: gws
        kind: npm
        package: "@googleworkspace/cli"
        bins: ["gws"]
        label: Install Google Workspace CLI (npm)
---

# Google Workspace via gws CLI

## Step 1: Check auth before anything else

HybridClaw injects `GOOGLE_WORKSPACE_CLI_TOKEN` into the agent runtime when
Google auth is configured with `hybridclaw auth login google`.

Run exactly `gws auth status` (no API call, instant) and parse the JSON output.
Do not add `--json`; `gws auth status --json` is invalid because auth status
already prints JSON by default.

Treat auth as configured when any of these are true:

- `credential_source` is `"token_env_var"`
- `token_env_var` is `true`
- `auth_method` is not `"none"`
- `storage` is not `"none"`

This matters because HybridClaw passes its Google OAuth token through
`GOOGLE_WORKSPACE_CLI_TOKEN`; current `gws auth status` may still report
`auth_method: "none"` for that env-token mode.

Only if none of the authenticated states above are present, tell the user:

> Run `hybridclaw auth login google` in your terminal to connect your Google account.

If env-token auth is present, do not ask the user to log in again. Continue
with the requested `gws` command immediately.

That's it. Don't explain OAuth, GCP projects, scopes, or alternatives unless a
later `gws` command returns an auth or scope error.
The HybridClaw login flow works for both personal Gmail and Workspace accounts.

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
