---
title: Model Selection
description: Model prefixes, selection commands, and scope behavior across global, agent, and session settings.
sidebar_position: 2
---

# Model Selection

Model prefixes:

- Codex models use `openai-codex/`
- OpenRouter models use `openrouter/`
- local backends use prefixes such as `ollama/`, `lmstudio/`, and `vllm/`

Examples:

```text
/model set openai-codex/gpt-5-codex
/model list codex
/model default openai-codex/gpt-5-codex
/model list openrouter
/model set openrouter/anthropic/claude-sonnet-4
/model clear
/agent model openrouter/anthropic/claude-sonnet-4
/model info
```

## Scope Rules

- `hybridai.defaultModel` in `~/.hybridclaw/config.json` is the global default
- `/agent model <name>` sets the persistent model for the current session agent
- `/model set <name>` is a session-only override
- `/model clear` removes the session override and falls back to the agent or
  global default
- `/model info` shows the active model by scope

Use `HYBRIDCLAW_CODEX_BASE_URL` to override the default Codex backend base URL
when needed.
