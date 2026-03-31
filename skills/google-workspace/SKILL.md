---
name: google-workspace
description: Work with Gmail, Calendar, Drive, Docs, and Sheets via browser automation or APIs.
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

1. For email-only tasks, prefer the optional `himalaya` community skill if it is installed, or the existing email channel when that is simpler.
2. For Calendar, Drive, Docs, or Sheets tasks, **default to browser automation** using the persistent browser profile. Do not ask which method to use — just try the browser first.
3. If the browser hits a login page, tell the user to run `hybridclaw browser login` to sign in once, then retry. Do not ask for credentials in chat.
4. Only fall back to API-based access if the user explicitly requests it or browser automation is unavailable.

## Proactive Behavior

When the user asks about their calendar, email, or documents:

- **Act immediately.** Navigate to the relevant Google service via browser automation without asking clarifying questions.
- Use sensible defaults: current week, user's calendar timezone, all event types.
- Present results in a clean bullet list grouped by day.
- Only ask for clarification when genuinely ambiguous (e.g., which calendar if multiple exist).

## Browser Login Setup

HybridClaw uses a persistent browser profile that survives across sessions. The user logs in once and the agent reuses that session.

- If the browser lands on a Google login page, respond with:
  > I need you to log into Google first. Run `hybridclaw browser login` in your terminal, sign into your Google account in the browser that opens, then close it. After that, ask me again and I will have access.
- Never ask the user to paste passwords or credentials into chat.
- Never attempt to automate the Google login form (triggers bot detection).

## API Guidance

If the user explicitly requests API automation and does not have credentials:

1. Tell them to create a Google Cloud project.
2. Enable the APIs they need: Gmail, Calendar, Drive, Docs, Sheets, People.
3. Create an OAuth desktop client or service account, depending on their environment.
4. Keep credential files outside the repo and outside version control.
5. Confirm which scopes are actually needed before proceeding.

## Rules

- Never send email or create calendar events without explicit confirmation.
- Always state whether you are using browser automation or an API path.
- Do not assume a shared Drive folder, spreadsheet, or document is accessible until you confirm it exists.
- Prefer structured intermediate data such as Markdown or CSV before pushing content into Docs or Sheets.
