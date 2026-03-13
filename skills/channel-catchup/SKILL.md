---
name: channel-catchup
description: Summarize scoped channel activity across Discord, ingested email threads, WhatsApp, and TUI. Use this when the user asks for a catch-up, recap, key posts, important updates, or a summary of the last N messages / recent timeframe from one or more channels.
user-invocable: true
disable-model-invocation: false
metadata:
  hybridclaw:
    tags:
      - channels
      - summary
      - catchup
      - discord
      - email
---

# Channel Catchup

Use this skill when the user wants a concise catch-up or summary of channel content.

Examples:

- "Summarize the last 50 messages from `#announcements` and `#engineering`."
- "Give me the important posts from our HybridAI Discord server today."
- "Catch me up on this email thread."
- "Summarize what happened in the current TUI session."

## Default To Action

Do not reflexively ask for scope if you can already do a useful catch-up from available context and tools.

Default to the broadest safe scope you can actually resolve:

- If channels are explicit, use them.
- If the platform/thread is explicit and no count is given, use sensible defaults.
- If the request is broad but concrete targets are already visible in context or tool output, read them and summarize.
- Only ask a clarification when no concrete readable target can be resolved without guessing.

When a reasonable assumption is needed, make it, do the catch-up, and state the assumption after the summary instead of blocking first.

Default limits when the user did not specify them:

- Discord: last 50 messages per resolved channel
- Email: last 20 messages from the current or explicit ingested thread
- If no timeframe is provided, summarize the most recent activity visible in those reads

## Scope Resolution

Resolve scope aggressively instead of asking for it.

Use these defaults:

1. if the platform is clear, proceed on that platform
2. if the target set is broad, use all concrete readable targets you can already resolve
3. if no timeframe is given, prefer the latest visible activity
4. if no count is given, use the default limits above

Only ask a clarification when you cannot identify any concrete readable target without guessing.
If you had to infer scope, note the assumption after the answer in one short line and keep moving.

## Channel-Specific Workflow

### Discord

- Use `message` with `action="read"` for each target channel before summarizing.
- Prefer explicit channel IDs. If the user gives `#channel-name`, include `guildId`.
- Read each channel separately, then merge findings into one summary.
- Do not say you need pasted messages if you can read the requested Discord channels directly.
- If the user names a Discord server but not channels, default to all concrete readable channels you can already resolve from context, tool descriptions, prior tool output, or the current server context.
- If the ask is broad and you can resolve multiple channels, prefer covering more channels over asking for narrower scope.
- If channels are explicit but timeframe is missing, read the recent bounded sample and summarize it as the latest activity instead of blocking on timeframe selection.
- Ask only if you still cannot identify any concrete readable channels without guessing.

Recommended pattern:

```json
{"action":"read","channelId":"#announcements","guildId":"1412305846125203539","limit":50}
```

Example user ask:

`Use message read to fetch the last 50 messages from #announcements, #general, and #engineering in guild 1412305846125203539, then summarize the last 24 hours.`

### Email

- Use `message` with `action="read"` for the current ingested email thread or an explicit email address.
- If already in email context, omit `channelId` to read the current thread.
- Email read only covers threads already ingested by the gateway.
- Do not claim mailbox-wide unread inbox access. That capability does not exist here.

Recommended patterns:

```json
{"action":"read","limit":20}
```

```json
{"action":"read","channelId":"user@example.com","limit":20}
```

### WhatsApp

- There is no first-class WhatsApp history read action yet.
- If the current session context already contains the relevant conversation, summarize that directly.
- Otherwise ask for a pasted transcript/export or clearly state that full historical WhatsApp catch-up is not available through tools yet.
- Only use `session_search` if the user wants topic-based recall and accepts approximate recall rather than a strict "last N messages" summary.

### TUI / Local

- There is no first-class TUI history read action yet.
- If the needed content is already in the current session context, summarize it directly.
- Otherwise ask for a transcript/export or narrower current-session scope.
- Do not pretend you can fetch arbitrary historical TUI messages when no direct read path exists.

## Synthesis Rules

After reading the scoped content:

- lead with the few most important updates
- separate facts from inferred significance
- include decisions, blockers, and follow-ups if present
- compress repetition
- do not quote large message dumps unless the user asks

Default summary shape:

1. top 3-7 important updates
2. decisions made
3. open questions / blockers
4. action items

If the user asks for "short", keep it to a tight executive summary.

## Constraints

- Never summarize unseen content as if you read it.
- Do not use `session_search` as a substitute for chronological channel reads when the user explicitly asked for the last N messages from Discord or email.
- For multi-channel Discord catchups, read first, summarize second.
- Prefer doing a broad useful catch-up over asking for scope. If in doubt, cover all readable channels or threads with visible activity that you can actually resolve, then mention your assumption afterward. Do not invent channels, guilds, or mailbox access that the tools did not reveal.
- For email catchups, preserve thread context and reply in normal email style if responding by email.
- If replying by email, append a polished corporate signature block derived from `IDENTITY.md` details already loaded in context. Prefer full name, role, organization, and any real contact details that are present. Do not invent contact details, and do not use emoji or mascot-style sign-offs.
