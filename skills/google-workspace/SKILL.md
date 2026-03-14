---
name: google-workspace
description: Use this skill when the user needs Gmail, Calendar, Drive, Docs, or Sheets workflows, especially setup guidance, browser-driven actions, or API-based automation for Google Workspace.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - google
      - workspace
      - office
      - gmail
      - calendar
    related_skills:
      - himalaya
---

# Google Workspace

Use this skill for Google Workspace workflows that go beyond HybridClaw's built-in email and Discord channels.

## Scope

- Gmail searches and draft/send workflows
- Calendar event review and creation
- Drive file lookup
- Docs and Sheets editing or export workflows
- setup guidance for Google Cloud OAuth credentials or existing Google tooling

## Default Strategy

1. For email-only tasks, prefer `himalaya` or the existing email channel when that is simpler.
2. For Calendar, Drive, Docs, or Sheets tasks, prefer an already configured API helper, MCP server, or an authenticated browser session.
3. If no Google integration exists yet, guide setup first instead of inventing credentials or pretending access exists.

## Setup Guidance

When the user wants API automation and does not already have credentials:

1. Tell them to create a Google Cloud project.
2. Enable the APIs they need: Gmail, Calendar, Drive, Docs, Sheets, People.
3. Create an OAuth desktop client or service account, depending on their environment.
4. Keep credential files outside the repo and outside version control.
5. Confirm which scopes are actually needed before proceeding.

Do not ask the user to paste raw client secrets into chat unless they insist.

## Browser-First Guidance

If the user is already logged into Google in the browser:

- Use browser automation for one-off reads, navigation, and form entry.
- Draft Gmail content or Calendar details in chat first, then confirm before submitting.
- Confirm timezone, attendees, and meeting title before creating calendar events.
- For Docs or Sheets updates, write the intended content structure first, then apply it.

## API Guidance

If the user already has a configured API path:

- Use the existing local helper or direct HTTPS calls.
- Keep requests scoped and idempotent where possible.
- Read before write.
- Respect rate limits and retry guidance.

## Rules

- Never send email or create calendar events without explicit confirmation.
- Always state whether you are using browser automation or an API path.
- Do not assume a shared Drive folder, spreadsheet, or document is accessible until you confirm it exists.
- Prefer structured intermediate data such as Markdown or CSV before pushing content into Docs or Sheets.
