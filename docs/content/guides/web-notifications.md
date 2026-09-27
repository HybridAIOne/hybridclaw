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

## Operations and security

The gateway creates one VAPID keypair on first enablement and stores it as
`WEB_PUSH_VAPID_KEYS` in the encrypted runtime credential store. Back up that
store together with the gateway data directory. Subscriptions, session/operator
bindings, preferences, and the latest 100 unread alerts per operator persist in
`web-notifications.json` with owner-only permissions. Each operator can subscribe
up to 16 browsers. Master-token and local-session access share the local operator;
signed-in users and scoped API tokens have separate notification identities.

The authenticated `/api/push/*` endpoints require `chat.send`. Mutations use the
gateway's same-origin checks for cookie authentication. Bodies cannot select
another operator. Push endpoints require public HTTPS, and both initial and
connect-time DNS checks reject private addresses; redirects are not followed.
The service worker stores only its operator binding and does not cache chat,
API responses, or credentials. External push is disabled in A2A local mode.

Push delivery is best effort. Network failures leave history and unread state
available, and the gateway logs a generic warning without subscription URLs or
keys. Alerts do not approve actions: approval decisions still happen in chat.
