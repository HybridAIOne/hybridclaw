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
hybridclaw auth login local ollama llama3.2
hybridclaw auth login msteams --app-id 00000000-0000-0000-0000-000000000000 --tenant-id 11111111-1111-1111-1111-111111111111 --app-password secret
hybridclaw auth status hybridai
hybridclaw auth logout hybridai
hybridclaw auth whatsapp reset
```

## Notes

- `hybridclaw auth login` without a provider runs the standard onboarding flow.
- `hybridclaw auth login hybridai` prefers browser login on local GUI machines
  and falls back to a manual flow on headless shells.
- `hybridclaw auth login codex` prefers browser PKCE locally and device code on
  headless or remote shells.
- `hybridclaw auth login local` configures Ollama, LM Studio, or vLLM in
  `~/.hybridclaw/config.json`.
- `hybridclaw auth login msteams` enables Microsoft Teams and stores the app
  secret for later gateway startup.

## Where Credentials Live

- `~/.hybridclaw/credentials.json` stores HybridAI, OpenRouter, Discord,
  email, Teams, and related runtime secrets
- `~/.hybridclaw/codex-auth.json` stores Codex OAuth credentials
- `~/.hybridclaw/config.json` stores provider enablement and related runtime
  config

Legacy aliases such as `hybridclaw codex status` and
`hybridclaw local configure ...` still work, but the `auth` namespace is the
current primary surface.
