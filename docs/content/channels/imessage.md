# How To Set Up iMessage

HybridClaw supports iMessage in two modes:

1. `local`: HybridClaw runs on the same Mac that owns the Messages app data
2. `bluebubbles`: HybridClaw runs remotely and uses a separate Mac running BlueBubbles Server

Pick one backend per gateway process.

## Before You Start

You will edit:

- runtime config: `~/.hybridclaw/config.json`
- runtime secrets: `~/.hybridclaw/credentials.json`

You can start from [config.example.json](https://github.com/HybridAIOne/hybridclaw/blob/main/config.example.json) and copy the
`imessage` block into your local runtime config.

## Quick Setup Commands

For the common local-macOS case:

```bash
hybridclaw channels imessage setup --allow-from +14155551212
hybridclaw gateway restart --foreground
```

For a remote relay:

```bash
hybridclaw channels imessage setup --backend remote --server-url https://bluebubbles.example.com --password YOUR_IMESSAGE_PASSWORD --allow-from +14155551212
hybridclaw gateway restart --foreground
```

The setup command keeps group chats disabled by default. Without
`--allow-from`, inbound iMessage stays disabled and the channel is outbound-only.

## Option A: Local macOS Setup

Use this when HybridClaw is running on the same Mac that is signed into
Messages.

### Step 1: Install `imsg`

Install [`imsg`](https://github.com/steipete/imsg) on the Mac and verify it is
available on your `PATH`:

```bash
imsg --help
```

If you install it somewhere else, set that absolute path in
`imessage.cliPath`.

### Step 2: Grant Full Disk Access

HybridClaw reads the Messages database at:

```text
~/Library/Messages/chat.db
```

Grant Full Disk Access to whatever launches HybridClaw:

- Terminal
- iTerm
- launchd service wrapper
- app launcher shell

Without this, inbound polling will fail even if outbound sends work.

### Step 3: Confirm Messages Works Normally

Before involving HybridClaw, confirm the signed-in macOS user can already:

- open the Messages app
- receive iMessages
- send a manual reply from the same account

If the Mac account cannot send iMessages directly, HybridClaw will not fix that.

### Step 4: Add the iMessage Config

Open `~/.hybridclaw/config.json` and add or update:

```json
{
  "imessage": {
    "enabled": true,
    "backend": "local",
    "cliPath": "imsg",
    "dbPath": "/Users/example/Library/Messages/chat.db",
    "pollIntervalMs": 2500,
    "dmPolicy": "allowlist",
    "groupPolicy": "disabled",
    "allowFrom": ["+14155551212"],
    "groupAllowFrom": [],
    "textChunkLimit": 4000,
    "debounceMs": 2500,
    "mediaMaxMb": 20
  }
}
```

Recommended starting values:

- `dmPolicy: "allowlist"`
- `groupPolicy: "disabled"`
- `allowFrom`: only your own phone number or test contact

That keeps the first rollout private by default.

### Step 5: Start the Gateway

```bash
hybridclaw gateway start --foreground
```

If you already had the gateway running, restart it after editing config.

### Step 6: Send a Test Message

From an allowlisted iMessage handle:

1. Send a direct iMessage to the Mac account
2. Wait for HybridClaw to ingest it
3. Confirm HybridClaw replies in the same chat

### Step 7: Expand Access Carefully

After the first successful DM test, optionally expand:

- `dmPolicy` to `open`
- `groupPolicy` to `allowlist` or `open`
- `groupAllowFrom` for specific group participants

Group chats are intentionally disabled by default.

## Option B: Remote Setup with BlueBubbles

Use this when HybridClaw runs on a cloud VM, Linux box, or another machine that
does not have direct access to the macOS Messages database.

### Step 1: Set Up the Mac Relay

On the Mac that owns the iMessage account:

1. Install BlueBubbles Server
2. Sign it into the correct Messages account
3. Confirm BlueBubbles itself can see chats and send messages
4. Set a server password

Keep that Mac awake, online, and able to reach Messages normally.

### Step 2: Expose BlueBubbles to HybridClaw

HybridClaw needs a reachable `serverUrl`, for example:

```text
https://bluebubbles.example.com
```

By default, HybridClaw blocks loopback and private-network BlueBubbles hosts.
If you intentionally use a private address or internal DNS name, you must set:

```json
{
  "imessage": {
    "allowPrivateNetwork": true
  }
}
```

Only do that when you trust the network path.

### Step 3: Save the BlueBubbles Password

Store the password in the encrypted `~/.hybridclaw/credentials.json` store as
`IMESSAGE_PASSWORD`.

Recommended:

```bash
hybridclaw channels imessage setup --backend remote --server-url https://bluebubbles.example.com --password YOUR_IMESSAGE_PASSWORD
```

For headless or container deployments, provide the master key through
`HYBRIDCLAW_MASTER_KEY` or `/run/secrets/hybridclaw_master_key`. Do not rely on
plaintext `imessage.password` in config unless you have a very good reason.

### Step 4: Add the iMessage Config

Open `~/.hybridclaw/config.json` and add or update:

```json
{
  "imessage": {
    "enabled": true,
    "backend": "bluebubbles",
    "serverUrl": "https://bluebubbles.example.com",
    "webhookPath": "/api/imessage/webhook",
    "allowPrivateNetwork": false,
    "dmPolicy": "allowlist",
    "groupPolicy": "disabled",
    "allowFrom": ["+14155551212", "user@example.com"],
    "groupAllowFrom": [],
    "textChunkLimit": 4000,
    "debounceMs": 2500,
    "mediaMaxMb": 20
  }
}
```

### Step 5: Start HybridClaw

```bash
hybridclaw gateway start --foreground
```

By default, the iMessage webhook will be served at:

```text
http://127.0.0.1:9090/api/imessage/webhook
```

If HybridClaw itself is remote, expose that gateway over HTTPS so BlueBubbles
can reach it.

### Step 6: Register the BlueBubbles Webhook

Point BlueBubbles to the HybridClaw webhook URL.

Use header auth:

```text
POST https://your-hybridclaw.example.com/api/imessage/webhook
X-HybridClaw-iMessage-Password: YOUR_IMESSAGE_PASSWORD
```

This is the primary and recommended setup. Use it unless your relay or proxy
cannot send custom headers.

Fallback only:

```text
https://your-hybridclaw.example.com/api/imessage/webhook?password=YOUR_IMESSAGE_PASSWORD
```

Warning: query-string secrets are more likely to end up in reverse-proxy access
logs, browser history, and similar request traces. Only use the query-param
form when header auth is genuinely unavailable.

HybridClaw accepts:

- header: `X-HybridClaw-iMessage-Password` (preferred)
- query params: `password`, `guid`, or `token` (fallback only)

The webhook must send `new-message` events to HybridClaw for inbound delivery.

### Step 7: Send a Test Message

From an allowlisted iMessage handle:

1. Send a direct iMessage to the account on the BlueBubbles Mac
2. Confirm BlueBubbles sends the webhook to HybridClaw
3. Confirm HybridClaw creates a session and replies
4. Confirm the reply appears back on the Mac/iMessage side

### Step 8: Expand Access Carefully

Once direct-message tests pass, you can widen policy:

- add more entries to `allowFrom`
- change `dmPolicy` to `open`
- allow groups with `groupPolicy`
- add explicit group participants in `groupAllowFrom`

## Policy Reference

### `dmPolicy`

- `open`: reply to any direct iMessage
- `allowlist`: reply only to handles listed in `allowFrom`
- `disabled`: ignore direct messages

### `groupPolicy`

- `open`: reply in any group chat
- `allowlist`: reply only when sender handles match `groupAllowFrom`
- `disabled`: ignore group chats

## Common Problems

### Local backend starts but never sees inbound messages

Check:

1. Full Disk Access for the launching shell or service
2. `imessage.dbPath` points to the real `chat.db`
3. The gateway is running on macOS

### Local backend sends fail

Check:

1. `imsg` is installed
2. `imessage.cliPath` is correct
3. The current macOS user can send messages manually from Messages

### BlueBubbles outbound fails immediately

Check:

1. `imessage.serverUrl` is reachable from the HybridClaw host
2. `IMESSAGE_PASSWORD` matches the BlueBubbles server password
3. `allowPrivateNetwork` is enabled if you intentionally use a private host

### BlueBubbles receives messages but HybridClaw never sees them

Check:

1. BlueBubbles webhook URL points to `/api/imessage/webhook`
2. The webhook includes the correct password
3. The webhook is sending `new-message` events
4. Your reverse proxy actually forwards POST requests to the gateway

## Final Smoke Test

After setup is complete:

1. Restart the gateway
2. Send a DM from an allowlisted handle
3. Confirm the session appears and the reply returns
4. Test one attachment send
5. If you plan to use groups, test one controlled allowlisted group next

Do not move to `open` policies until the direct-message path is stable.
