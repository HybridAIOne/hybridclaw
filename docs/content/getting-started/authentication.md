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
hybridclaw auth login openrouter anthropic/claude-sonnet-4 --api-key sk-or-...
hybridclaw auth login mistral mistral-large-latest --api-key mistral_...
hybridclaw auth login huggingface meta-llama/Llama-3.1-8B-Instruct --api-key hf_...
hybridclaw auth login local lmstudio --base-url http://127.0.0.1:1234
hybridclaw auth login local ollama llama3.2
hybridclaw auth login local vllm mistralai/Mistral-7B-Instruct-v0.3 --base-url http://127.0.0.1:8000 --api-key secret
hybridclaw auth login msteams --app-id 00000000-0000-0000-0000-000000000000 --tenant-id 11111111-1111-1111-1111-111111111111 --app-password secret
hybridclaw auth login slack --bot-token xoxb-... --app-token xapp-...
hybridclaw auth status hybridai
hybridclaw auth status codex
hybridclaw auth status openrouter
hybridclaw auth status mistral
hybridclaw auth status huggingface
hybridclaw auth status local
hybridclaw auth status msteams
hybridclaw auth status slack
hybridclaw auth logout hybridai
hybridclaw auth logout codex
hybridclaw auth logout openrouter
hybridclaw auth logout mistral
hybridclaw auth logout huggingface
hybridclaw auth logout local
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
- `hybridclaw auth login openrouter`, `hybridclaw auth login mistral`, and
  `hybridclaw auth login huggingface` can take `--api-key`, otherwise they fall
  back to `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, or `HF_TOKEN`, or prompt
  interactively.
- `hybridclaw auth login local` configures Ollama, LM Studio, llama.cpp, or
  vLLM in `~/.hybridclaw/config.json`.
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
- `hybridclaw auth logout local` disables configured local backends and clears
  any saved vLLM API key.
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
hybridclaw secret show <NAME> [--raw]
hybridclaw secret unset <NAME>
hybridclaw secret route list
hybridclaw secret route add <url-prefix> <secret-name> [header] [prefix|none]
hybridclaw secret route remove <url-prefix> [header]
```

```text
/secret list
/secret set <NAME> <VALUE>
/secret show <NAME>
/secret unset <NAME>
/secret route list
/secret route add <url-prefix> <secret-name> [header] [prefix|none]
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

## Where Credentials Live

- `~/.hybridclaw/credentials.json` stores HybridAI, OpenRouter, Mistral,
  Hugging Face, Discord, Slack, Telegram, email, Teams, BlueBubbles iMessage,
  vLLM, web/gateway auth tokens, related runtime secrets, and named
  `/secret set` values in encrypted form
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
