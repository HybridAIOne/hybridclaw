# Web chat notifications

Open **Notifications** in the chat sidebar, choose **Enable notifications**,
and allow the browser permission prompt. Select whether to receive completed
requests, reminders and scheduled output, or approval alerts. Preferences apply
to the signed-in operator across subscribed browsers; enabling or disabling
notifications applies to the current browser.

Use HTTPS (or localhost). With service workers and Push API support, alerts can
arrive after closing the chat tab. The sidebar confirms when closed-tab alerts
are enabled. The gateway must remain running and the browser and operating
system must allow background notifications; focus modes and power settings can
delay delivery. On iOS/iPadOS, install the site on the Home Screen before enabling
push ([WebKit requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)). The console includes an installable web app manifest.

Browsers without push support can show alerts while the chat page is open in
the background. Unread indicators in the conversation list and tab title work
even when permission is denied. Opening a visible conversation marks its alerts
read. Clicking an alert opens its conversation. Alerts contain generic text,
not message previews or approval details.

Web reminders created with `cron add` default to their originating conversation;
an explicit `channel` still delivers to that channel. Scheduled web output is
saved in history at the scheduled run time, even with no browser connected.
Channel active-hours queues do not delay writing web history. A config-only
job without an originating web session cannot target bare `web`; create the
reminder from chat or choose a messaging channel. Push failure does not erase
the stored message or rerun the job.

**Disable notifications** removes this browser's push subscription. Logging out
also disables its service worker alerts. Permission can be revoked in browser
site settings. Expired push subscriptions are removed when the push service
returns 404 or 410; reopening chat attempts to restore enabled subscriptions.

## Pairing a device

Start pairing in the phone app and note its short code. In the gateway console,
open **Credentials → Devices**, check the client name and source IP, and approve
that code. Approval requires permission to create API tokens. Codes expire after
10 minutes; if the gateway restarts, start pairing again.

The device receives its own token with `chat.send`, `agents.read`,
`artifacts.read`, `voice.session`, and `sign_ins.manage`. It can chat, call the
agent, list agents, download reply documents, retrieve single stored replies
from chats it started, and save website sign-ins for the agent's browser. Manage or revoke the token under
**Credentials → API tokens**. Pairing does not enable phone push by itself; the
app must also register its phone as described below.

## Phones

A phone app registers itself by sending a command in web chat. The phone
belongs to the operator who opened that conversation, like a browser:

```
/push register <APNs token in hex> <sandbox|production> [kind,kind] [app]
/push unregister <APNs token in hex>
/push status
```

Each answers one line of JSON. Without kinds a phone gets the three browser
kinds, `turn`, `reminder` and `approval`, each only while the operator's
preference for it is on. An app that names other kinds, such as `proactive`,
gets those from plugins that send them, or from tasks added with
`/schedule add --alert <kind>`, whose alert shows the first item a run lists,
or the reply itself for a task added with `--reply-only` as well. Each operator can register up to 16
phones; registering a phone another operator holds moves it.

A phone rings only for conversations its own app chats in. Each web chat
request records the HybridAI app it came from: the `appId` field of
`/api/chat`, such as `hy` or `salescompanion`, or `hy` for a request with
`client: "mobile"` and no `appId`. The browser and scripts send neither. A
phone registers for one app with `[app]`, `hy` when left out. A reply,
reminder or alert in a conversation last used from the browser, a script or
another app does not ring the phone, even when the same operator sent it.
HybridAI signs each alert for the phone's app and refuses to register a phone
for an app it does not sign for (`"reason": "unknown_app"`). A registration
answer names the phone's `app`; a runtime that does not answer with it rings
the phone for every app's chats.

A finished reply (`turn`) and a request for approval (`approval`) show the
assistant's name as the title and a fixed line as the body, "Done. Your reply
is ready." or "Needs your approval to go on.", never the reply or the request
itself. That line is also sent as `loc-key`, so an app that translates it shows
it in the phone's language. The phone app calls the default agent Hy, so its
alerts say Hy whatever the agent is named here; other agents go by their
display name, then their name, and an agent without either is Hy too. A
reminder shows the assistant's name as its title and the reminder itself as its
body (up to 240 characters), and its badge counts the
operator's reminders not yet read (`/api/push/read`). Unlike browser alerts,
the reminder's text is on the lock screen, which iOS hides while locked unless
previews are set to always show. The payload holds `kind`, `id`, `sessionId`
and `agentId` next to `aps`, and `thread-id` is the conversation. A reminder
adds `messageId`, the stored reply (also the last part of `id`), which the app
reads with `GET /api/chat/message?sessionId=…&id=…`. A reply of a task added
with `--alert` rings with its listed items instead of as a reminder; one added
with `--reply-only` too rings like a reminder of the alert's kind. The message
read back carries `source`, `schedule:<id>` for a reply a task posted.

Apple's signing key is not on the gateway. The gateway hands each alert to
HybridAI (`POST /v1/push` on `hybridai.baseUrl`), authenticated with the
configured HybridAI key; HybridAI signs it for the app the phone registered
for (`app` in the request) and forwards it to APNs. Without a HybridAI key, phones get nothing, and `/push status`
says `"relay": false`. When APNs reports a phone gone, the gateway forgets it.
Tokens are stored with the browser subscriptions and are never logged.

HybridAI forwards only to phones bound to the key's account, so `/push
register` binds the phone first (`POST /v1/push/devices`). A phone bound to
another account is not kept and the command answers
`{"registered": false, "reason": "taken", "error": "…"}`. If HybridAI cannot
be reached, the phone is kept and bound on its first alert, which is then
retried once. `/push unregister` releases the binding (`DELETE
/v1/push/devices`) once no operator on the gateway holds the phone; that is
best effort. In A2A local mode nothing is sent to HybridAI.

## Operations and security

The gateway creates one VAPID keypair on first enablement and stores it as
`WEB_PUSH_VAPID_KEYS` in the encrypted runtime credential store. Back up that
store together with the gateway data directory. Subscriptions, session/operator
bindings, preferences, and the latest 100 unread alerts per operator persist in
`web-notifications.json` with owner-only permissions. Each operator can subscribe
up to 16 browsers. Master-token and local-session access share the local operator;
signed-in users and scoped API tokens have separate notification identities.
Deleting a session through the gateway removes its notification binding and
unread alerts. Recording an alert commits once and reuses that snapshot for
browser and push delivery.

The authenticated `/api/push/*` endpoints require `chat.send`. Mutations use the
gateway's same-origin checks for cookie authentication. Bodies cannot select
another operator. Push endpoints require public HTTPS, and both initial and
connect-time DNS checks reject private addresses; redirects are not followed.
The service worker stores only its operator binding and does not cache chat,
API responses, or credentials. External push is disabled in A2A local mode.

Push delivery is best effort. Network failures leave history and unread state
available, and the gateway logs a generic warning without subscription URLs or
keys. Alerts do not approve actions: approval decisions still happen in chat.
