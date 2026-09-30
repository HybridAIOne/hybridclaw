# Proactive Assistant

Lets the mail and calendar of the connected HybridAI account produce
suggestions while no conversation is running: a mail arrives or a calendar
entry changes, and the user's app shows a suggestion under **For your
attention**. A suggestion is an editable chat draft. Nothing here sends,
accepts or changes anything.

The gateway does the watching and the deciding, because it is the agent: it
has the user's goals and quiet hours and it is always on. HybridAI keeps the
two things a gateway must not hold, the Google connection and the push key,
and is only asked.

## Enable

The container image carries the plugin as an install-on-demand source. The npm
package does not.

```sh
hybridclaw plugin enable proactive-assistant              # container image
hybridclaw plugin install ./plugins/proactive-assistant   # source checkout
```

`/plugin enable proactive-assistant` from a web session does the same and
reloads the plugin runtime. It needs the gateway's HybridAI credential
(`HYBRIDAI_API_KEY`) and no configuration. Enabling it reads nothing: the
user switches the feed on from their app.

## What it reads

Every five minutes, for the account the gateway is signed in as, through two
read-only connector tools on HybridAI (`/api/v1/connectors/mcp`):

| Source | Tool | Reported |
| --- | --- | --- |
| `gmail` | `google_workspace__list_new_messages` | Mail that reached the inbox since the last look: sender, subject, date and preview. Never the body. |
| `calendar` | `google_workspace__list_calendar_changes` | Events other people added, changed or cancelled, and timed events starting within a day: title, time, place and guests. Never the description. |

A source is watched only while HybridAI lists its tool, which it does when
Google is connected with that read permission and the user has not disabled
the tool. The plugin keeps the cursors the tools hand back; HybridAI stores
none.

What is new goes to the auxiliary model in one request **without tools**,
together with the user's priorities and the titles of earlier suggestions. It
may propose up to three next steps. Mail and invitations are written by
strangers: the output is parsed as data, every field is length-checked, a
malformed proposal is dropped, and a suggestion's source comes from the event
it points at. A crafted mail can make a suggestion misleading; it cannot make
anything run, because the user has to read, send and approve the draft in
chat.

## The `proactive` command

The user's app reaches the gateway through chat, so the feed is a command:

```text
/proactive feed
/proactive configure <base64url of {"enabled": true, "goals": "", "quiet_start": 22,
                                    "quiet_end": 8, "time_zone": "Europe/Berlin",
                                    "language": "de-DE"}>
/proactive dismiss <suggestion id>
/proactive review <suggestion id>
```

Every operation answers with the feed as one line of JSON:

```json
{"version": 1,
 "settings": {"enabled": true, "goals": "", "quiet_start": 22, "quiet_end": 8, "time_zone": "Europe/Berlin"},
 "sources": [{"id": "gmail", "available": true}, {"id": "calendar", "available": true}],
 "suggestions": [{"id": "…", "source": "gmail", "title": "…", "detail": "…", "why": "…", "prompt": "…", "created_at": "2026-09-30T09:00:00.000Z"}],
 "last_checked_at": "2026-09-30T09:00:00.000Z",
 "error": null}
```

or with `{"version": 1, "failure": "<code>"}`:

| Failure | Meaning |
| --- | --- |
| `not_owner` | The caller is not the HybridAI account whose connectors are read. |
| `not_signed_in` | The gateway has no HybridAI credential. |
| `unavailable` | HybridAI could not be asked whose credential it is. |
| `invalid_settings` | The settings were not acceptable; nothing changed. |
| `not_found` | No suggestion has that id. |
| `unknown_operation` | Not one of the four operations. |

`error` is about the last look: `reconnect_google` (the connection is dead),
`source_unavailable` (Google or HybridAI could not be reached, or the tool
needs an approval) or `assessment_failed` (the model request failed).

Notes for a client:

- `configure` takes base64url because chat splits a command on whitespace.
  `enabled` must be stated; the other settings take their defaults when
  omitted. Suggestions are written in `language`.
- The reply escapes a line break inside a string as `\u000a`, a carriage
  return as `\u000d` and a backslash as `\`, so it survives a chat relay
  whose clients turn the two characters `\n` into a line break. It is still
  plain JSON.
- A chat message that starts with a command the gateway does not know is
  answered by the model. So a client must know the plugin is loaded before it
  sends `/proactive`. `/plugin list installed` is always a command, changes
  nothing, and lists `commands: /proactive` while the plugin is loaded.
  `/plugin enable proactive-assistant` loads it and answers with
  `Status: enabled`; it also reloads every plugin, so it is for the first time
  only.
- The feed belongs to the account, not to one agent, because mail and
  calendar are connected per user.

## Behaviour

- **Opt-in.** Nothing is read until the owner switches the feed on. That
  takes bookmarks: mail already in the inbox did not "arrive". Switching it
  off deletes the suggestions and the bookmarks.
- **Owner only.** The command answers the HybridAI account whose credential
  the gateway uses, and nobody else who can chat with it. Another account
  signing in starts with an empty feed.
- **Quiet hours** (the user's clock; equal hours mean none) skip the look and
  leave the cursors alone, so the night's mail is looked at in the morning.
  The first look after switching on runs regardless.
- **Failures** leave the cursors where they were. The third failed
  assessment of the same events passes them over, so one mail a provider
  always refuses cannot block the feed.
- **A settings change** during a look discards what that look found.
- **Push.** A new suggestion is announced once through HybridAI
  (`POST /v1/push`, kind `proactive`, the title only), outside quiet hours.
  Without a registered phone it is tried again on the next twelve looks.
- **Storage.** `proactive-assistant/state.json` under the runtime home, mode
  0600, outside every agent workspace. It holds settings, cursors and what
  the model wrote, for 14 days and at most 100 suggestions. Nothing read from
  Google is stored, and logs carry error types, never content.

Model usage is accounted like any other auxiliary-model call. A look with
nothing new makes no model request.

## Not built

- Outlook mail and Microsoft 365 calendars.
- Gmail push (Pub/Sub) instead of polling; the delay is up to five minutes.
- Using the agent's memory in the assessment. It sees the events, the user's
  priorities and earlier suggestion titles only.
- A feed per agent, or a push that names one.

## Validation

`tests/proactive-assistant-plugin.test.ts` covers the command, the checks and
the HybridAI client against stand-ins. The command was also called through a
running gateway's `/api/chat` as a web chat turn, including from the iPhone
app on a simulator, and the image was built with the plugin enabled inside
it. The model request and the two connector tools have not run against a live
provider or a real mailbox.
