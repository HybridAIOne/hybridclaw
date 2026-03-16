# Setting Up MS Teams

HybridClaw uses the Microsoft Bot Framework webhook flow for Teams. You need
three things before it can receive messages:

1. A Microsoft Entra app registration for the bot
2. An Azure Bot resource with the Microsoft Teams channel enabled
3. A public HTTPS endpoint that forwards to your local gateway

## 1. Get the bot credentials

In the Azure portal:

1. Open `Microsoft Entra ID` -> `App registrations`
2. Create or open the app registration used by your bot
3. Copy:
   - `Application (client) ID` -> use as `--app-id`
   - `Directory (tenant) ID` -> use as `--tenant-id`
4. Open `Certificates & secrets` -> `New client secret`
5. Copy the secret `Value` immediately -> use as `--app-password`

If you do not already have a bot resource, create an `Azure Bot` resource and
connect it to that app registration, then enable the Microsoft Teams channel on
that bot.

## 2. Save the credentials in HybridClaw

```bash
hybridclaw auth login msteams --app-id <APP_ID> --tenant-id <TENANT_ID> --app-password <APP_PASSWORD>
```

If you want interactive prompts instead:

```bash
hybridclaw auth login msteams
```

That interactive flow prompts for:
- app id
- app password
- tenant id (optional)

Check what HybridClaw saved:

```bash
hybridclaw auth status msteams
```

By default, Teams DMs and group channels start in `allowlist` mode. That means
the bot will not answer anyone until you explicitly allow AAD object IDs in
config or open a specific team/channel policy for testing.

Do not rely on display names in `allowFrom` unless you have no alternative.
`msteams.dangerouslyAllowNameMatching` is intentionally dangerous:
- Teams display names are mutable
- display names are not guaranteed to be unique
- a name-based allowlist grant is logged with a warning so you can find and
  remove it later

Prefer stable AAD object IDs in `msteams.allowFrom`.

## 3. Start the gateway

```bash
hybridclaw gateway restart --foreground
```

By default, Teams messages are served from the gateway HTTP port at:

```text
http://127.0.0.1:9090/api/msteams/messages
```

## 4. Expose the webhook on HTTPS

Teams needs a public HTTPS URL. For local testing, expose the gateway with a
tunnel such as `ngrok`:

```bash
ngrok http 9090
```

Take the public HTTPS URL and use this as your Teams messaging endpoint:

```text
https://<your-public-host>/api/msteams/messages
```

## 5. Register the webhook in Azure

In your Azure Bot resource, set the bot messaging endpoint to:

```text
https://<your-public-host>/api/msteams/messages
```

Then confirm the Microsoft Teams channel is enabled for that bot.

## 6. Smoke-test the bot

For a quick test, either:

1. temporarily set `msteams.dmPolicy` / `msteams.groupPolicy` to `open`, or
2. add your own AAD object ID to `msteams.allowFrom`

1. Open a DM with the bot in Microsoft Teams and send `hello`
2. Confirm the bot replies
3. Add the bot to a Team/channel and send `@BotName hello`
4. Confirm the bot replies in-channel

Channel messages require a mention by default, so a plain `hello` in a Team
channel should not trigger a reply unless you change the Teams policy in
runtime config.

## 7. Clean up or reset

Use these commands when you need to inspect or remove the setup:

```bash
hybridclaw help msteams
hybridclaw auth status msteams
hybridclaw auth logout msteams
```
