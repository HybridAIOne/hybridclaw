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
hybridclaw auth login huggingface meta-llama/Llama-3.1-8B-Instruct --api-key hf_...
hybridclaw auth login local lmstudio --base-url http://127.0.0.1:1234
hybridclaw auth login local ollama llama3.2
hybridclaw auth login msteams --app-id 00000000-0000-0000-0000-000000000000 --tenant-id 11111111-1111-1111-1111-111111111111 --app-password secret
hybridclaw auth status hybridai
hybridclaw auth status openrouter
hybridclaw auth status huggingface
hybridclaw auth status local
hybridclaw auth logout hybridai
hybridclaw auth logout openrouter
hybridclaw auth logout huggingface
hybridclaw auth logout local
hybridclaw auth whatsapp reset
```

## Notes

- `hybridclaw auth login` without a provider runs the standard onboarding flow.
- `hybridclaw auth login hybridai` prefers browser login on local GUI machines
  and falls back to a manual flow on headless shells.
- `hybridclaw auth login codex` prefers browser PKCE locally and device code on
  headless or remote shells.
- `hybridclaw auth login openrouter` and `hybridclaw auth login huggingface`
  can take `--api-key`, otherwise they fall back to `OPENROUTER_API_KEY` or
  `HF_TOKEN`, or prompt interactively.
- `hybridclaw auth login local` configures Ollama, LM Studio, llama.cpp, or
  vLLM in `~/.hybridclaw/config.json`.
- The local backend model id is optional. If omitted, HybridClaw enables the
  backend and you can pick a model later with `/model list <backend>`.
- Interactive onboarding can skip remote provider auth entirely when you plan
  to use a local backend instead.
- `hybridclaw auth login msteams` enables Microsoft Teams and stores the app
  secret for later gateway startup.
- `hybridclaw auth status hybridai` reports whether HybridAI is authenticated,
  where the active API key came from, the masked key, the active config file,
  the configured base URL, and the default model.
- Local TUI and web sessions can store additional named secrets with
  `/secret set <NAME> <VALUE>` and bind them to outbound API calls with
  `/secret route add <url-prefix> <secret-name> [header] [prefix|none]`.

## Where Credentials Live

- `~/.hybridclaw/credentials.json` stores HybridAI, OpenRouter, Hugging Face,
  Discord, email, Teams, related runtime secrets, and named `/secret set`
  values in encrypted form
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
- `imessage.password`
- `local.backends.vllm.apiKey`

Use `{ "source": "store", "id": "SECRET_NAME" }`,
`{ "source": "env", "id": "ENV_VAR" }`, or `${ENV_VAR}` shorthand in those
fields.

Legacy aliases such as `hybridclaw codex status` and
`hybridclaw local configure ...` still work, but the `auth` namespace is the
current primary surface.
