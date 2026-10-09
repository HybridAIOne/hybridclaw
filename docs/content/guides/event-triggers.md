# Event triggers

A trigger runs an instruction when something arrives instead of at a time:
"when an invoice arrives by mail, save it to my Library", "when someone posts
a bug in #support, summarise it", "give me a web address that adds what it
receives to my shopping list". Users set them up in chat; the agent saves them
with the `trigger` tool. Apps and the TUI use `/schedule add --on`.

A trigger is a `--reply-only` scheduled task, so `/schedule list`, `toggle`,
`remove` and `update` work on it like on any task, and `list --json` shows
its `trigger` (`source`, `channel`, `contains`, and a webhook's `url` and
`path`). Each event queues a one-shot run that works in a session of its own.
The run replies only when it did something or has something to tell; then
the reply reaches the chat the trigger belongs to (for web chats, the agent's
main chat) and rings the owner's phones like a reminder. Queued runs are not
listed; pausing or deleting the trigger cancels them.

## Sources

| Source    | What runs it | What the run gets |
| --------- | ------------ | ----------------- |
| `mail`    | A trusted relay reporting new mail (`gmail`, `outlook`, `mailbox`), and an optional cron as a regular look | Nothing: it reads mail received since its last look with the connected mail tools |
| `slack`   | A message in a Slack channel the Slack channel config lets the bot hear (`groupPolicy`, `groupAllowFrom`), mention or not; or a relayed `slack` change | The message, fenced as outside data; a relayed change carries nothing |
| `webhook` | A `POST` to `/api/triggers/<token>` | The request body, fenced as outside data |

A Slack trigger can be limited to one `channel` (name or id) and to messages
that `contain` some text. Direct and group direct messages never run a trigger.

The `trigger` tool gives a mail trigger a regular look every two hours from 8
to 20 in the user's time zone unless told otherwise, because only Gmail
announces new mail today. Gmail push makes it run within seconds.

## Webhooks

The web address is `deployment.public_url` (cloud mode) or `ops.gatewayBaseUrl`
plus `/api/triggers/<token>`. The 43-character token is the only credential,
so anyone who has the address can run the instruction; delete the trigger to
revoke it. A call answers:

- `202` with `queued`, `duplicate` (an `Idempotency-Key`, `webhook-id` or
  `X-GitHub-Delivery` header seen in the last day) or `ignored` (paused).
- `404` for an unknown address, `413` above 64 KB, `429` with `Retry-After`
  past 30 runs an hour or 5 waiting runs.

JSON bodies are pretty-printed; the run sees at most 8,000 characters.

## Limits and safety

Content from mail, Slack and webhooks is outside data. The run prompt fences
it and tells the model never to follow instructions in it; sending, paying
and buying still go through the normal approval rules. Mail and relayed
changes wait 15 seconds for a burst and look at most once a minute; each
trigger runs at most 30 times an hour. Event ids are remembered for a day.

See [Connector change events](./connector-events.md) for the relay that
reports new mail and Slack changes.
