---
title: Authentication
description: Provider login, status, logout, and credential storage behavior.
sidebar_position: 4
---

# Authentication

HybridClaw uses one provider-focused command surface:

```bash
hybridclaw auth login hybridai --browser
hybridclaw auth login hybridai --base-url http://localhost:5000
hybridclaw auth login codex --import
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
hybridclaw auth login google --client-id 000000000000-example.apps.googleusercontent.com --client-secret GOCSPX-example --account you@example.com
hybridclaw auth login msteams --app-id 00000000-0000-0000-0000-000000000000 --tenant-id 11111111-1111-1111-1111-111111111111 --app-password secret
hybridclaw auth status hybridai
hybridclaw auth status codex
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
hybridclaw auth logout hybridai
hybridclaw auth logout codex
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
- `hybridclaw auth login openrouter`, `hybridclaw auth login mistral`,
  `hybridclaw auth login huggingface`, and the other API-key providers
  (`gemini`, `deepseek`, `xai`, `zai`, `kimi`, `minimax`, `dashscope`,
  `xiaomi`, `kilo`) can take `--api-key`, otherwise they fall back to the
  matching environment variable (e.g. `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`,
  `HF_TOKEN`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`,
  `ZAI_API_KEY`, `KIMI_API_KEY`, `MINIMAX_API_KEY`, `DASHSCOPE_API_KEY`,
  `XIAOMI_API_KEY`, `KILO_API_KEY`), or prompt interactively.
- `hybridclaw auth login local` configures Ollama, LM Studio, llama.cpp, or
  vLLM in `~/.hybridclaw/config.json`.
- `hybridclaw auth login google` stores a Google OAuth desktop client id,
  client secret, account, and refresh token for API access through the bundled
  `gog` skill. Create the desktop OAuth client in Google Cloud Console, then
  pass its **Client ID** and **Client secret** to the command above. The
  command prints a Google authorization URL and waits for the local OAuth
  callback; approve the requested scopes in the browser to store the refresh
  token.
- Google API access through `gog` also requires the relevant Google Cloud APIs
  to be enabled in the same project, for example Gmail API, Google Calendar
  API, Google Drive API, Google Docs API, Google Sheets API, and People API.
  If the OAuth app is in testing mode, add your Google account as a test user
  before authorizing.
- The local backend model id is optional. If omitted, HybridClaw enables the
  backend and you can pick a model later with `/model list <backend>`.
- Interactive onboarding can skip remote provider auth entirely when you plan
  to use a local backend instead.
- `hybridclaw auth login msteams` enables Microsoft Teams and stores the app
  secret for later gateway startup. It can prompt for the app id, app
  password, and optional tenant id.
- Interactive credential prompts keep pasted secrets hidden instead of echoing
  them back to the terminal.
- `hybridclaw auth status hybridai` reports whether HybridAI is authenticated,
  where the active API key came from, whether a key is configured, the active
  config file, the configured base URL, and the default model without printing
  the credentials file path or any partial secret value.
- `hybridclaw auth logout local` disables configured local backends and clears
  any saved vLLM API key.
- `hybridclaw auth logout google` clears the stored Google OAuth material used
  to mint short-lived `gog` access tokens.
- `hybridclaw auth logout msteams` clears the stored Teams app password and
  disables the Teams integration in config.
- `hybridclaw auth whatsapp reset` clears linked WhatsApp Web auth without
  starting a new pairing session.
- Local TUI and web sessions can store additional named secrets with
  `/secret set <NAME> <VALUE>` and bind them to outbound API calls with
  `/secret route add <url-prefix> <secret-name> [header] [prefix|none]`.
- Only one running HybridClaw process should own
  `~/.hybridclaw/credentials/whatsapp` at a time. If WhatsApp Web shows
  duplicate linked devices or reconnect drift, stop the extra process, run
  `hybridclaw auth whatsapp reset`, then pair again with
  `hybridclaw channels whatsapp setup`.

## Where Credentials Live

- `~/.hybridclaw/credentials.json` stores HybridAI, OpenRouter, Mistral,
  Hugging Face, Gemini, DeepSeek, xAI, Z.AI, Kimi, MiniMax, DashScope,
  Xiaomi, Kilo Code, Google OAuth for `gog`, Discord, email, Teams,
  BlueBubbles iMessage, related runtime secrets, and named `/secret set` values
  in encrypted form
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
