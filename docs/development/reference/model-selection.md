---
title: Model Selection
description: Model prefixes, selection commands, and scope behavior across global, agent, and session settings.
sidebar_position: 2
---

# Model Selection

Model prefixes:

- Codex models use `openai-codex/`
- OpenRouter models use `openrouter/`
- Mistral models use `mistral/`
- Hugging Face router models use `huggingface/`
- local backends use prefixes such as `ollama/`, `lmstudio/`, and `vllm/`

The shipped default Codex model is `openai-codex/gpt-5-codex`.

Examples:

```text
/model set openai-codex/gpt-5-codex
/model list codex
/model default openai-codex/gpt-5-codex
/model list openrouter
/model set openrouter/anthropic/claude-sonnet-4
/model list mistral
/model set mistral/mistral-large-latest
/model list huggingface
/model set huggingface/meta-llama/Llama-3.1-8B-Instruct
/model clear
/agent model openrouter/anthropic/claude-sonnet-4
/model info
/concierge info
/concierge on
/concierge model gemini-3-flash
/concierge profile no_hurry ollama/qwen3:latest
```

## Scope Rules

- `hybridai.defaultModel` in `~/.hybridclaw/config.json` is the global default;
  it can point at a HybridAI model, an `openai-codex/...` model, an
  `openrouter/...` model, a `mistral/...` model, a `huggingface/...` model, or
  a local backend model such as `ollama/...`
- `/agent model <name>` sets the persistent model for the current session agent
- `/model set <name>` is a session-only override
- `/model clear` removes the session override and falls back to the agent or
  global default
- `/model default [name]` shows or sets the global default model for new
  sessions
- `/model info` shows the effective, session, agent, and default models

## Allowed Model Lists

- `codex.models` controls the allowed Codex model list shown in selectors and
  status output
- `openrouter.models` controls the allowed OpenRouter model list shown in
  selectors and status output
- `mistral.models` controls the allowed Mistral model list shown in selectors
  and status output
- `huggingface.models` controls the allowed Hugging Face model list shown in
  selectors and status output
- HybridAI model lists are refreshed from the configured HybridAI base URL
  (`/models`, then `/v1/models` as a compatibility fallback), and discovered
  `context_length` values feed status and model-info output when the API
  exposes them

## Provider Routing

- when the selected model starts with `openai-codex/`, HybridClaw resolves
  OAuth credentials through the Codex provider instead of `HYBRIDAI_API_KEY`
- when the selected model starts with `openrouter/`, HybridClaw resolves
  credentials through `OPENROUTER_API_KEY`
- when the selected model starts with `mistral/`, HybridClaw resolves
  credentials through `MISTRAL_API_KEY`
- when the selected model starts with `huggingface/`, HybridClaw resolves
  credentials through `HF_TOKEN`

## Concierge Routing

- `/concierge on|off` toggles the global concierge router that can ask users
  about urgency before long-running requests
- `/concierge model [name]` shows or sets the small decision model used for
  concierge routing
- `/concierge profile <asap|balanced|no_hurry> [model]` shows or sets the
  execution model mapped to each concierge urgency profile

Use `HYBRIDAI_BASE_URL` to override `hybridai.baseUrl` for the current process
without rewriting runtime config, which is useful for local or preview
HybridAI deployments.
Use `HYBRIDCLAW_CODEX_BASE_URL` to override the default Codex backend base URL
when needed.

For provider login and default-model setup flows, see
[Authentication](../getting-started/authentication.md).
For local backend selection and picker behavior, see
[Local Providers](../guides/local-providers.md).
