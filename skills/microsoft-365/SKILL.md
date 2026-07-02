---
name: microsoft-365
description: "Read Microsoft 365 data through Microsoft Graph: Outlook mail/calendar, OneDrive/SharePoint files, Teams, chats, and user profile."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: microsoft-365-oauth
    kind: oauth
    required: true
    secret_ref:
      source: store
      id: MICROSOFT_365_ACCESS_TOKEN
    scope: "graph.microsoft.com"
    how_to_obtain: "Create a Microsoft Entra app registration with delegated Microsoft Graph read scopes, then run `hybridclaw auth login microsoft365 --client-id <client-id> --tenant-id organizations --account you@example.com`."
metadata:
  hybridclaw:
    category: productivity
    short_description: "Microsoft 365 via Microsoft Graph."
    tags:
      - microsoft
      - microsoft-365
      - m365
      - office-365
      - graph
      - outlook
      - onedrive
      - sharepoint
      - teams
    stakes_tiers:
      green:
        - profile-read
        - mail-read
        - calendar-read
        - file-read
        - teams-read
        - chat-read
    escalation:
      writes: unsupported
    cost_measurement:
      system: UsageTotals
      sub_limit_key: microsoft-365
---

# Microsoft 365

Use this skill for read-only Microsoft 365 workflows backed by Microsoft Graph.

## Scope

- read the signed-in user's Microsoft 365 profile
- list or search Outlook messages
- read calendar events in a requested time window
- list or search recent OneDrive files
- list joined Teams, team channels, channel messages, and recent chats
- interpret common Microsoft Graph auth, permission, and throttling errors

This skill is read-only. Do not send mail, create or update calendar events,
modify files, post Teams messages, or change tenant state with this skill.

## Credential Rules

HybridClaw stores Microsoft Entra OAuth refresh-token material in encrypted
runtime secrets. At request time the gateway mints a short-lived Microsoft
Graph access token and injects it only for `graph.microsoft.com`.

Recommended setup:

```bash
hybridclaw auth login microsoft365 \
  --client-id "<entra-app-client-id>" \
  --tenant-id organizations \
  --account you@example.com
hybridclaw auth status microsoft365
```

Use OAuth login for normal setup. If an operator must manually replace stored
Microsoft credential material, advise this order: browser admin at
`/admin/secrets`, `/secret set ...` in browser `/chat` or
TUI, then `hybridclaw secret set ...` in a local console.

Use a Microsoft Entra app registration with a localhost/mobile-desktop redirect
URI matching the callback URL printed by the login command. The default scope
set is read-only: `User.Read`, `Mail.Read`, `Calendars.Read`,
`Files.Read.All`, `Sites.Read.All`, `Team.ReadBasic.All`,
`Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `Chat.Read`, plus
`offline_access`.

Tenant admins may need to grant consent for the broader Graph read scopes.
Never paste client secrets, refresh tokens, or access tokens into chat.

For direct Graph calls outside this helper, configure a route:

```bash
hybridclaw secret route add https://graph.microsoft.com/v1.0/ microsoft-oauth Authorization Bearer
```

## Default Workflow

1. Start by building a helper request:
   ```bash
   node skills/microsoft-365/m365.cjs --format json http-request ...
   ```
2. For live reads, prefer the helper `run` command so the CJS script owns
   endpoint selection, gateway submission, and auth-error handling.
3. If using the built-in `http_request` tool directly, pass only the emitted
   `httpRequest` object. Do not handcraft Microsoft Graph requests from memory.
4. If a call returns 401, 403, `Authorization_RequestDenied`, or
   `insufficient_claims`, stop after the first failure and tell the operator to
   run `hybridclaw auth status microsoft365`, verify tenant admin consent, and
   reconnect with `hybridclaw auth login microsoft365` if needed.
5. If Graph returns 429, respect `Retry-After`; do not loop retries.

## Command Contract

Profile:

```bash
node skills/microsoft-365/m365.cjs --format json run me
node skills/microsoft-365/m365.cjs --format json http-request me
```

Outlook mail:

```bash
node skills/microsoft-365/m365.cjs --format json run mail recent --top 10
node skills/microsoft-365/m365.cjs --format json run mail search --query "from:alex@example.com" --top 10
```

Calendar:

```bash
node skills/microsoft-365/m365.cjs --format json run calendar events \
  --start 2026-06-26T00:00:00Z \
  --end 2026-06-27T00:00:00Z \
  --timezone Europe/Berlin
```

OneDrive and SharePoint-backed files:

```bash
node skills/microsoft-365/m365.cjs --format json run drive recent --top 25
node skills/microsoft-365/m365.cjs --format json run drive search --query "quarterly plan" --top 10
```

Teams and chats:

```bash
node skills/microsoft-365/m365.cjs --format json run teams joined --top 25
node skills/microsoft-365/m365.cjs --format json run teams channels --team-id "<team-id>"
node skills/microsoft-365/m365.cjs --format json run teams messages --team-id "<team-id>" --channel-id "<channel-id>" --top 10
node skills/microsoft-365/m365.cjs --format json run chats list --top 10
```

## Output Rules

Summarize returned JSON into concise user-facing answers. For mail, show sender,
subject, received time, read state, and a short snippet. For calendar events,
group by day and include timezone. For files, show name, modified time, and
link. For Teams/chats, show display names, timestamps, and links or IDs needed
for a follow-up read.
