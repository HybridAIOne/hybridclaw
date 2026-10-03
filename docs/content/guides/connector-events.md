# Connector change events

Hy's existing proactive check can run earlier when connected data changes.
Calendar, Reminders and Health snapshot uploads from the phone already emit
changes when their content differs; uploading identical content does not wake
Hy. Periodic checks remain the fallback, including during quiet hours.

An event queues a one-shot copy of an enabled, owned `/schedule` task with
`--reply-only --alert proactive` and a cron expression. It debounces changes
for 15 seconds, coalesces a pending burst, and allows at most one extra check
per five minutes. The last 128 event IDs per policy are retained for 24 hours
in SQLite, so restarts retain pending jobs and recent duplicate suppression.
When the periodic check is due sooner, it covers the event instead.

Early checks only run in hours containing a regular occurrence in the task's
timezone. Events in quiet hours wait for the ordinary scheduled check. The
original policy still decides whether a change is worth notifying; an event
is not a notification by itself. Pausing, deleting or editing the policy
cancels an already queued copy before model execution. Owners and delivery
sessions are rechecked, and disconnected phone sources remain inaccessible.

## Cloud connector relays

Install the bundled `connector-events` plugin and enable it:

```bash
hybridclaw plugin install connector-events
hybridclaw plugin enable connector-events
```

Store a dedicated `CONNECTOR_EVENTS_TOKEN` credential through the secret
settings or `hybridclaw secret set`. Configure bindings through plugin config:

```json
{
  "bindings": [
    { "id": "alice-mail", "source": "gmail", "userId": "alice", "taskId": 42 }
  ]
}
```

`userId` must be the verified gateway identity that created task 42, not an
email address inferred from a message. The runtime ignores bindings whose
policy is missing, disabled or belongs to another user. Send over HTTPS:

```http
POST /api/plugin-webhooks/connector-events/change
Authorization: Bearer <dedicated relay token>
Content-Type: application/json

{"bindingId":"alice-mail","eventId":"opaque-provider-event-id"}
```

The response is HTTP 202 with `queued`, `coalesced`, `duplicate`, `scheduled`
or `ignored`. Missing/wrong credentials get 401; malformed or extra fields get
400. Tokens in URLs are not accepted. Rotate the credential without reloading
the plugin. Event bodies cannot choose the user, task, prompt or delivery target.

A trusted platform/provider relay must validate provider notifications and map
them to the configured binding. This plugin does not create Gmail, Microsoft
Graph or calendar subscriptions, or automatically subscribe connected accounts.
It supplies the authenticated event entry point. No message body or event
payload is placed in the model prompt; Hy rereads current connected sources
using the original proactive policy and its existing approval rules.
