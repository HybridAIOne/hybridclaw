---
name: google-workspace
description: Use browser automation for Google Workspace web UI tasks in Gmail, Calendar, Drive, Docs, and Sheets.
user-invocable: true
metadata:
  hybridclaw:
    category: productivity
    short_description: "Google Workspace via browser."
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

For API-backed Google Workspace access, prefer the bundled `gws` or `gog` skill
when available.

## Scope

- Gmail searches and draft/send workflows
- Calendar event review and creation
- Drive file lookup
- Docs and Sheets editing or export workflows
- setup guidance for Google Cloud OAuth credentials or existing Google tooling

## Default Strategy

1. For API-backed Gmail, Calendar, Drive, Contacts, Sheets, or Docs tasks, use the bundled `gws` skill first when it is installed. Use `gog` when it is a better fit for the command surface or `gws` is unavailable.
2. Start by running exactly `gws auth status` or `gog`'s equivalent lightweight status/help command. Do not run `gws auth status --json`; auth status already prints JSON and does not accept `--json`. For `gws`, treat `credential_source: "token_env_var"` or `token_env_var: true` as authenticated even when `auth_method` is `"none"`, because HybridClaw injects `GOOGLE_WORKSPACE_CLI_TOKEN`. If the CLI reports no usable auth, tell the user to run `hybridclaw auth login google`; do not ask for `hybridclaw browser login`.
3. For email-only tasks where `gws` and `gog` are unavailable, prefer the optional `himalaya` community skill if it is installed, or the existing email channel when that is simpler.
4. Use browser automation only when the user explicitly asks for browser-based work or the task needs visual inspection in the Google web UI.
5. If browser automation is explicitly needed and the browser hits a login page, tell the user to run `hybridclaw browser login` to sign in once, then retry. Do not ask for credentials in chat.

## Proactive Behavior

When the user asks about their calendar, email, or documents:

- **Act immediately.** Use `gws` or `gog` without asking clarifying questions.
- Use sensible defaults: current week, user's calendar timezone, all event types.
- Present results in a clean bullet list grouped by day.
- Only ask for clarification when genuinely ambiguous (e.g., which calendar if multiple exist).

## Browser Login Setup

Browser login is only for visual Google web UI workflows. For API-backed Gmail,
Calendar, Drive, Docs, and Sheets work, use `hybridclaw auth login google`
through `gws` or `gog` instead.

HybridClaw uses a persistent browser profile that survives across sessions. The user logs in once and the agent reuses that session.

- If the browser lands on a Google login page, respond with:
  > I need you to log into Google first. Run `hybridclaw browser login` in your terminal, sign into your Google account in the browser that opens, then close it. After that, ask me again and I will have access.
- Never ask the user to paste passwords or credentials into chat.
- Never attempt to automate the Google login form (triggers bot detection).

## API Guidance

If `gws` or `gog` reports missing Google API auth:

1. Tell them to run `hybridclaw auth login google`.
2. If setup still fails, tell them to enable the APIs they need: Gmail, Calendar, Drive, Docs, Sheets, People.
3. Do not ask for OAuth client secrets, refresh tokens, passwords, or credential files in chat.

## Rules

- Never send email or create calendar events without explicit confirmation.
- Always state whether you are using browser automation or an API path.
- Do not assume a shared Drive folder, spreadsheet, or document is accessible until you confirm it exists.
- Prefer structured intermediate data such as Markdown or CSV before pushing content into Docs or Sheets.
