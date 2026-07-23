# Setting Up Microsoft Teams

HybridClaw uses the Microsoft Bot Framework webhook flow for Teams. The same
single-tenant Microsoft Entra application ID connects the Entra app
registration, HybridClaw channel, Azure Bot resource, and Teams app.

## Step 1: Create the Entra app registration

1. Open the
   [Microsoft Entra app registration form](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/false).
2. Enter a name for the app.
3. For **Supported account types**, select **Accounts in this organizational
   directory only (Single tenant)**.
4. Leave **Redirect URI** empty. The Teams bot channel does not need one.
5. Register the app.
6. From the app's **Overview** page, copy both:
   - **Application (client) ID**
   - **Directory (tenant) ID**

Keep the app page open. You need it again when creating the client secret.

## Step 2: Enable the channel in HybridClaw

1. Open `/admin/channels#msteams`.
2. Open the **Microsoft Teams** channel.
3. Turn on **Enabled**.
4. Paste the **Application (client) ID** into **App ID**.
5. Paste the **Directory (tenant) ID** into **Tenant ID**.
6. Save the channel settings.

## Step 3: Create and save the client secret

1. Return to the Entra app registration.
2. Open **Certificates & secrets** -> **Client secrets**.
3. Create a client secret and copy its **Value** immediately. Microsoft only
   displays that value once.
4. Open `/admin/credentials?tab=secrets` in HybridClaw.
5. Create or update the secret named `MSTEAMS_APP_PASSWORD` and use the copied
   client secret value as its password.

Use the client secret **Value**, not its **Secret ID**. On a running gateway,
setting or rotating `MSTEAMS_APP_PASSWORD` from the Credentials page refreshes
the Teams credential and Bot Framework adapter in process. A container restart
is not required.

## Step 4: Create the Azure Bot resource

1. Open the [Azure portal](https://portal.azure.com/) and create an **Azure
   Bot** resource.
2. Select **Single Tenant** and **Use existing app registration** when
   prompted.
3. Enter the **Application (client) ID** from Step 1. If Azure asks for a tenant
   ID, enter the **Directory (tenant) ID** from the same app registration.
4. Set the bot's messaging endpoint to:

   ```text
   https://u-sp57rprd6kv7akzh.sbx.hybridai.one/api/msteams/messages
   ```

5. In the Azure Bot resource, open **Settings** -> **Channels** and enable the
   **Microsoft Teams** channel.

The endpoint above is for the hosted HybridClaw environment used by this guide.
For a different cloud or self-hosted deployment, use its public HTTPS origin
with the same path:

```text
https://<your-public-host>/api/msteams/messages
```

For local testing, expose the gateway's HTTP port through an HTTPS tunnel or
reverse proxy first. The local endpoint is
`http://127.0.0.1:9090/api/msteams/messages`, but Azure Bot must be configured
with the public HTTPS URL.

## Step 5: Create and download the Teams app

1. Open the [Teams Developer Portal](https://dev.teams.cloud.microsoft/) and
   create a Teams app.
2. Use the **Application (client) ID** from Step 1 as the app ID.
3. Under **Features**, add or enable **Bot**.
4. Use the same **Application (client) ID** for the bot and enable these scopes:
   - **Personal**
   - **Team**
5. Save the app, open **Publish**, and download the app package.

Keep the downloaded `.zip` file intact. It is the package uploaded in the next
step.

## Step 6: Upload the app for your organization

1. Open the [Teams admin center](https://admin.teams.microsoft.com/).
2. Go to **Teams apps** -> **Manage apps**.
3. Select **Upload new app** and upload the `.zip` package downloaded from the
   Teams Developer Portal.
4. Make the app available to the intended users through your organization's
   Teams app policies.

The app can take some time to appear in the organization's Teams app catalog.

## Step 7: Verify the setup

1. Install the app from your organization's Teams app catalog.
2. Open a direct message with the bot and send `hello`.
3. Add the app to a team and send `@BotName hello` in a channel.
4. Confirm the bot replies in both places.

Team channel messages require a mention by default. A plain `hello` in a team
channel does not trigger a reply unless you change the Teams policy in
HybridClaw.

## Troubleshooting: the bot does not respond

The default DM policy is `allowlist`, so the bot does not respond to a direct
message until the sender is allowed.

1. Open `/admin/channels#msteams` and select the **Microsoft Teams** channel.
2. Expand **Advanced delivery settings**.
3. Either:
   - add your Microsoft Entra user object ID to **Allowed AAD object IDs**, or
   - temporarily change **DM policy** from `allowlist` to `open`
4. Save the channel settings and send another direct message to the bot.

Using `open` allows any user who can reach the bot to send it direct messages.
Prefer adding stable AAD object IDs before wider use. Do not use display names
unless there is no alternative: display names are mutable and not guaranteed
to be unique.

If direct messages work but team channel messages do not, check **Group policy**
in the same section, verify the app was added to that team, and mention the bot
in the message.

If authentication fails, confirm that `MSTEAMS_APP_PASSWORD` contains the
client secret **Value**, that the secret has not expired, and that all four
resources use the same Application (client) ID.

## CLI alternative

You can save the same three HybridClaw values from the command line instead of
Steps 2 and 3:

```bash
hybridclaw auth login msteams --app-id <APP_ID> --tenant-id <TENANT_ID> --app-password <APP_PASSWORD>
```

For interactive prompts, run:

```bash
hybridclaw auth login msteams
```

Inspect or remove the saved setup with:

```bash
hybridclaw help msteams
hybridclaw auth status msteams
hybridclaw auth logout msteams
```
