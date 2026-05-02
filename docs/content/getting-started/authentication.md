---
title: Authentication
description: Provider login, status, logout, and credential storage behavior.
sidebar_position: 4
---

# Authentication

HybridClaw uses one provider-focused command surface:

```bash
hybridclaw auth login
hybridclaw auth login hybridai --device-code
hybridclaw auth login hybridai --browser
hybridclaw auth login hybridai --import
hybridclaw auth login hybridai --base-url http://localhost:5000
hybridclaw auth login codex --device-code
hybridclaw auth login codex --browser
hybridclaw auth login codex --import
hybridclaw auth login anthropic anthropic/claude-sonnet-4-6 --method api-key --api-key sk-ant-...
hybridclaw auth login anthropic anthropic/claude-sonnet-4-6 --method claude-cli
hybridclaw auth login openrouter anthropic/claude-sonnet-4 --api-key sk-or-...
hybridclaw auth login mistral mistral-large-latest --api-key mistral_...
hybridclaw auth login huggingface meta-llama/Llama-3.1-8B-Instruct --api-key hf_...
hybridclaw auth login gemini gemini-2.5-pro --api-key AIza...
hybridclaw auth login deepseek deepseek-chat --api-key sk-...
hybridclaw auth login xai grok-3 --api-key xai-...
hybridclaw auth login zai glm-5 --api-key ...
hybridclaw auth login kimi kimi-k2.5 --api-key ...
hybridclaw auth login minimax MiniMax-M2.5 --api-key ...
hybridclaw auth login dashscope qwen3-coder-plus --api-key ...
hybridclaw auth login xiaomi mimo-v2-pro --api-key ...
hybridclaw auth login kilo anthropic/claude-sonnet-4.6 --api-key ...
hybridclaw auth login local lmstudio --base-url http://127.0.0.1:1234
hybridclaw auth login local ollama llama3.2
hybridclaw auth login local vllm mistralai/Mistral-7B-Instruct-v0.3 --base-url http://127.0.0.1:8000 --api-key secret
hybridclaw auth login google --client-id 000000000000-example.apps.googleusercontent.com --client-secret GOCSPX-example --account you@example.com
hybridclaw auth login msteams --app-id 00000000-0000-0000-0000-000000000000 --tenant-id 11111111-1111-1111-1111-111111111111 --app-password secret
hybridclaw auth login slack --bot-token xoxb-... --app-token xapp-...
hybridclaw auth status hybridai
hybridclaw auth status codex
hybridclaw auth status anthropic
hybridclaw auth status openrouter
hybridclaw auth status mistral
hybridclaw auth status huggingface
hybridclaw auth status gemini
hybridclaw auth status deepseek
hybridclaw auth status xai
hybridclaw auth status zai
hybridclaw auth status kimi
hybridclaw auth status minimax
hybridclaw auth status dashscope
hybridclaw auth status xiaomi
hybridclaw auth status kilo
hybridclaw auth status local
hybridclaw auth status google
hybridclaw auth status msteams
hybridclaw auth status slack
hybridclaw auth logout hybridai
hybridclaw auth logout codex
hybridclaw auth logout anthropic
hybridclaw auth logout openrouter
hybridclaw auth logout mistral
hybridclaw auth logout huggingface
hybridclaw auth logout gemini
hybridclaw auth logout deepseek
hybridclaw auth logout xai
hybridclaw auth logout zai
hybridclaw auth logout kimi
hybridclaw auth logout minimax
hybridclaw auth logout dashscope
hybridclaw auth logout xiaomi
hybridclaw auth logout kilo
hybridclaw auth logout local
hybridclaw auth logout google
hybridclaw auth logout msteams
hybridclaw auth logout slack
hybridclaw auth whatsapp reset
```

## Notes

- `hybridclaw auth login` without a provider runs the standard onboarding flow.
- `hybridclaw auth login hybridai` prefers browser login on local GUI machines
  and falls back to a manual flow on headless shells. `--import` copies the
  current `HYBRIDAI_API_KEY` from your shell into the encrypted secret store,
  and `--base-url` updates `hybridai.baseUrl` before login.
- `hybridclaw auth login codex` prefers browser PKCE locally and device code on
  headless or remote shells.
- `hybridclaw auth login anthropic --method api-key` stores
  `ANTHROPIC_API_KEY`, enables the direct Anthropic Messages API transport,
  and can set an `anthropic/...` model as the global default.
- `hybridclaw auth login anthropic --method claude-cli` uses the official
  `claude -p` transport after `claude auth login`. That transport currently
  requires host sandbox mode because the Claude CLI credentials and binary
  live on the host.
- `hybridclaw auth login openrouter`, `hybridclaw auth login mistral`,
  `hybridclaw auth login huggingface`, and the other API-key providers
  (`anthropic`, `gemini`, `deepseek`, `xai`, `zai`, `kimi`, `minimax`,
  `dashscope`, `xiaomi`, `kilo`) can take `--api-key`, otherwise they fall
  back to the matching environment variable (e.g. `ANTHROPIC_API_KEY`,
  `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `HF_TOKEN`, `GEMINI_API_KEY`,
  `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`,
  `MINIMAX_API_KEY`, `DASHSCOPE_API_KEY`, `XIAOMI_API_KEY`, `KILO_API_KEY`),
  or prompt interactively.
- `hybridclaw auth login local` configures Ollama, LM Studio, llama.cpp, or
  vLLM in `~/.hybridclaw/config.json`.
- `hybridclaw auth login google` stores a Google OAuth desktop client id,
  client secret, account, and refresh token for API access through the bundled
  `gog` and `gws` skills. Create the desktop OAuth client in Google Cloud
  Console, then pass its **Client ID** and **Client secret** to the command above. The
  command prints a Google authorization URL and waits for the local OAuth
  callback; approve the requested scopes in the browser to store the refresh
  token.
- Google API access through `gog` or `gws` also requires the relevant Google
  Cloud APIs to be enabled in the same project, for example Gmail API, Google
  Calendar API, Google Drive API, Google Docs API, Google Sheets API, and People API.
  If the OAuth app is in testing mode, add your Google account as a test user
  before authorizing.
- The local backend model id is optional. If omitted, HybridClaw enables the
  backend and you can pick a model later with `/model list <backend>`.
- Interactive onboarding can skip remote provider auth entirely when you plan
  to use a local backend instead.
- `hybridclaw auth login msteams` enables Microsoft Teams and stores the app
  secret for later gateway startup. It can prompt for the app id, app
  password, and optional tenant id.
- `hybridclaw auth login slack` enables Slack, stores `SLACK_BOT_TOKEN` plus
  `SLACK_APP_TOKEN`, and can prompt for either value when the terminal is
  interactive.
- Interactive credential prompts keep pasted secrets hidden instead of echoing
  them back to the terminal.
- `hybridclaw auth status <provider>` prints the local credentials path,
  whether the provider is authenticated, which source currently supplies the
  secret (`env` or `runtime-secrets`), and provider-specific config state
  without printing any secret value.
- `hybridclaw auth status codex` also reports whether a relogin is required,
  the active account id, and the token expiry timestamp.
- `hybridclaw auth status anthropic` reports the configured method,
  credential source, masked value, expiry for Claude CLI credentials when
  available, and the current `anthropic.*` config state.
- `hybridclaw auth logout local` disables configured local backends and clears
  any saved vLLM API key.
- `hybridclaw auth logout anthropic` clears the stored `ANTHROPIC_API_KEY`.
  Claude CLI credentials are managed separately by the `claude` CLI.
- `hybridclaw auth logout google` clears the stored Google OAuth material used
  to mint short-lived `gog` access tokens.
- `hybridclaw auth logout msteams` clears the stored Teams app password and
  disables the Teams integration in config.
- `hybridclaw auth logout slack` clears both stored Slack tokens and disables
  the Slack integration in config.
- `hybridclaw auth whatsapp reset` clears linked WhatsApp Web auth without
  starting a new pairing session.
- Only one running HybridClaw process should own
  `~/.hybridclaw/credentials/whatsapp` at a time. If WhatsApp Web shows
  duplicate linked devices or reconnect drift, stop the extra process, run
  `hybridclaw auth whatsapp reset`, then pair again with
  `hybridclaw channels whatsapp setup`.

## Named Secrets And Secret Routes

The encrypted runtime store also supports arbitrary named secrets and
gateway-side auth routing from local TUI and local web chat sessions:

```bash
hybridclaw secret list
hybridclaw secret set <NAME> <VALUE>
hybridclaw secret show <NAME>
hybridclaw secret unset <NAME>
hybridclaw secret route list
hybridclaw secret route add <url-prefix> <secret-name|google-oauth> [header] [prefix|none]
hybridclaw secret route remove <url-prefix> [header]
```

```text
/secret list
/secret set <NAME> <VALUE>
/secret show <NAME>
/secret unset <NAME>
/secret route list
/secret route add <url-prefix> <secret-name|google-oauth> [header] [prefix|none]
/secret route remove <url-prefix> [header]
```

- `/secret ...` remains local-session-only; use `hybridclaw secret ...` from a
  shell when you want the same secret-store workflow outside the chat surface
- secret names must use uppercase letters, digits, and underscores only
- built-in runtime keys such as `HYBRIDAI_API_KEY` and arbitrary names such as
  `STAGING_API_KEY` share the same encrypted store
- `/secret route add` writes `tools.httpRequest.authRules[]` so the
  gateway-side `http_request` tool can inject the real credential at send time
- use `prefix` for the default `Bearer <secret>` form or `none` when the raw
  secret should be sent unchanged
- you can still reference stored secrets explicitly in prompts with
  `<secret:NAME>` when that workflow is more appropriate than a URL auth rule

## Google OAuth For Direct Google APIs

Use the `google-oauth` route provider when an agent should call Google APIs
through `http_request` without seeing or handling an access token. This is the
right setup for APIs such as Google Analytics Admin, Google Analytics Data,
Google Ads, or other `*.googleapis.com` endpoints that are not covered by a
bundled skill command.

The route provider uses the same encrypted Google OAuth material created by
`hybridclaw auth login google`. At request time the gateway mints a
short-lived access token on the host and injects it into matching
`http_request` calls. The token is only injectable into `googleapis.com` or
`*.googleapis.com` requests.

### 1. Create A Google OAuth Client

1. Open [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Select or create a project dedicated to HybridClaw Google API access.
3. Open **OAuth consent screen** and finish the required app setup; if the app is in testing mode, add your Google account as a test user.
4. Open **Library** and enable every API you plan to call from this project; for GA4 reporting, enable Google Analytics Admin API and Google Analytics Data API.
5. Open **Credentials**.
6. Click **Create credentials**.
7. Choose **OAuth client ID**.
8. Choose application type **Desktop app**.
9. Copy the generated **Client ID** and **Client secret**.

Use an OAuth desktop client, not an API key. A service account can work for
some Google APIs, but it is a different setup and is not what
`google-oauth` routes use.

### 2. Authorize The Required Scopes

Run `auth login google` with the scopes needed by the APIs you will call. For
GA4 read-only reporting:

```bash
hybridclaw auth login google \
  --client-id "<client-id>" \
  --client-secret "<client-secret>" \
  --account you@example.com \
  --scopes "https://www.googleapis.com/auth/analytics.readonly"
```

If the same Google OAuth credential should also keep powering `gog` or `gws`,
include the Workspace scopes you need in the same `--scopes` value. Treat
`--scopes` as the complete grant you want stored for this Google login.

Check the stored account and scopes:

```bash
hybridclaw auth status google
```

### 3. Add URL Auth Routes

Add one route per Google API family, using narrow URL prefixes:

```bash
hybridclaw secret route add https://analyticsadmin.googleapis.com/ google-oauth Authorization Bearer
hybridclaw secret route add https://analyticsdata.googleapis.com/ google-oauth Authorization Bearer
```

The equivalent local TUI/web commands are:

```text
/secret route add https://analyticsadmin.googleapis.com/ google-oauth Authorization Bearer
/secret route add https://analyticsdata.googleapis.com/ google-oauth Authorization Bearer
```

List routes:

```bash
hybridclaw secret route list
```

Routes are stored in `~/.hybridclaw/config.json` as:

```json
{
  "urlPrefix": "https://analyticsdata.googleapis.com/",
  "header": "Authorization",
  "prefix": "Bearer",
  "secret": { "source": "google-oauth" }
}
```

### 4. Prompt The Agent

After the routes exist, prompts do not need `bearerSecretName` or
`Authorization` headers. Ask the agent to use `http_request` and call only the
Google API URLs:

```text
Get my GA4 report with http_request.

Use these APIs only:
- GET https://analyticsadmin.googleapis.com/v1alpha/accountSummaries?pageSize=200
- POST https://analyticsdata.googleapis.com/v1beta/properties/PROPERTY_ID:runReport

Do not use bash, gcloud, ADC, gog, or gws.
Do not read or print any token.
The configured Google OAuth auth routes should attach Authorization.
```

### Troubleshooting

- `SERVICE_DISABLED`: enable the named Google API in the same Google Cloud project that owns the OAuth client, then wait a few minutes and retry.
- `PERMISSION_DENIED` for a GA4 property: grant the authorized Google account Viewer or Analyst access to that GA4 property.
- `insufficient authentication scopes`: rerun `hybridclaw auth login google` with all required scopes.
- `401 Unauthorized`: rerun `hybridclaw auth login google`; the stored refresh token may have been revoked or the OAuth client may have changed.

## Google Ads Invoice Harvesting

Google Ads invoice harvesting uses the Google Ads API `InvoiceService`.
HybridClaw needs one OAuth route, one developer-token secret, and the Google Ads
account identifiers for the customer and billing setup.

### Required Google Setup

1. Open [Google Cloud Console APIs](https://console.cloud.google.com/apis/library/googleads.googleapis.com) in the project that owns your HybridClaw OAuth client.
2. Enable **Google Ads API** for that project.
3. Make sure the Google OAuth consent/app configuration can grant
   `https://www.googleapis.com/auth/adwords`.
4. In Google Ads, use a manager account to open
   [API Center](https://ads.google.com/aw/apicenter) and copy the developer
   token. Google Ads API calls require this token in the `developer-token`
   header.
5. Identify the target Google Ads client customer ID. Remove hyphens before
   using it in API calls, for example `436-246-3361` becomes `4362463361`.
6. If your signed-in user reaches the client through a manager/MCC account,
   note the manager customer ID as `login-customer-id`, also without hyphens.

### Store And Route Credentials

Authorize Google OAuth with the Google Ads scope. If this OAuth login also
powers Workspace or Analytics access, include those scopes in the same command;
`--scopes` is the complete grant to store.

```bash
hybridclaw auth login google \
  --client-id "<client-id>" \
  --client-secret "<client-secret>" \
  --account you@example.com \
  --scopes "https://www.googleapis.com/auth/adwords"

hybridclaw auth status google
```

Store the developer token:

```bash
hybridclaw secret set GOOGLEADS_DEVELOPER_TOKEN "<developer-token>"
```

Allow `http_request` to inject both headers only for Google Ads API calls:

```bash
hybridclaw secret route add https://googleads.googleapis.com/ google-oauth Authorization Bearer
hybridclaw secret route add https://googleads.googleapis.com/ GOOGLEADS_DEVELOPER_TOKEN developer-token none
```

Store non-secret Google Ads identifiers in the secret store when you want the
invoice harvester config to reference them uniformly:

```bash
hybridclaw secret set GOOGLEADS_CUSTOMER_ID "4362463361"
hybridclaw secret set GOOGLEADS_BILLING_SETUP "customers/4362463361/billingSetups/<billing-setup-id>"
hybridclaw secret set GOOGLEADS_LOGIN_CUSTOMER_ID "<manager-customer-id-without-hyphens>"
```

`GOOGLEADS_LOGIN_CUSTOMER_ID` is optional. Use it only when Google Ads returns
`USER_PERMISSION_DENIED` with guidance that a manager customer ID must be set.

### Discover Billing Setup

If you do not know the billing setup resource name, use GoogleAdsService search
with route-injected headers:

```text
POST https://googleads.googleapis.com/v20/customers/<customer-id>/googleAds:search
```

```sql
SELECT
  billing_setup.resource_name,
  billing_setup.payments_account,
  billing_setup.status
FROM billing_setup
```

Use the returned `billing_setup.resource_name` as the `billingSetup` parameter
for InvoiceService:

```text
GET https://googleads.googleapis.com/v20/customers/<customer-id>/invoices?billingSetup=<resource-name>&issueYear=2026&issueMonth=MAY
```

### Google Ads Troubleshooting

- `SERVICE_DISABLED`: enable **Google Ads API** in the Google Cloud project
  named by the error's `consumer` field. This is the project that owns the
  OAuth client.
- `USER_PERMISSION_DENIED`: verify the OAuth user has access to the target
  Google Ads customer, and add `login-customer-id` if access is through an
  MCC/manager account.
- `insufficient authentication scopes`: rerun `hybridclaw auth login google`
  with `https://www.googleapis.com/auth/adwords`.
- `404` from `POST /customers/<id>:search`: the endpoint is wrong. Use
  `/customers/<id>/googleAds:search`.

## Where Credentials Live

- `~/.hybridclaw/credentials.json` stores HybridAI, Anthropic, OpenRouter,
  Mistral, Hugging Face, Gemini, DeepSeek, xAI, Z.AI, Kimi, MiniMax,
  DashScope, Xiaomi, Kilo Code, Google OAuth for `gog`, Discord, Slack,
  Telegram, email, Teams, BlueBubbles iMessage, vLLM, web/gateway auth tokens,
  related runtime secrets, and named `/secret set` values in encrypted form
- `~/.hybridclaw/credentials.master.key`, `HYBRIDCLAW_MASTER_KEY`, or
  `/run/secrets/hybridclaw_master_key` supplies the master key used to decrypt
  runtime secrets
- `~/.hybridclaw/codex-auth.json` stores Codex OAuth credentials
- `~/.hybridclaw/config.json` stores provider enablement and related runtime
  config

Selected config fields also support SecretRefs instead of plaintext values.
Current built-in SecretRef surfaces include:

- `ops.webApiToken`
- `ops.gatewayApiToken`
- `email.password`
- `imessage.password`
- `local.backends.vllm.apiKey`

Use `{ "source": "store", "id": "SECRET_NAME" }`,
`{ "source": "env", "id": "ENV_VAR" }`, or `${ENV_VAR}` shorthand in those
fields.

Legacy aliases are still supported, for example:

```bash
hybridclaw hybridai login --browser
hybridclaw codex status
hybridclaw local configure ollama llama3.2
```

Legacy aliases such as `hybridclaw codex status` and
`hybridclaw local configure ...` still work, but the `auth` namespace is the
current primary surface.
