---
title: Model Selection
description: Model prefixes, selection commands, and scope behavior across global, agent, and session settings.
sidebar_position: 2
---

# Model Selection

Model prefixes:

- Codex models use `openai-codex/`
- Anthropic models use `anthropic/`
- OpenRouter models use `openrouter/`
- Mistral models use `mistral/`
- Hugging Face router models use `huggingface/`
- Google Gemini models use `gemini/`
- DeepSeek models use `deepseek/`
- xAI / Grok models use `xai/`
- Z.AI / GLM models use `zai/`
- Kimi / Moonshot models use `kimi/`
- MiniMax models use `minimax/`
- DashScope / Qwen models use `dashscope/`
- Xiaomi MiMo models use `xiaomi/`
- Kilo Code models use `kilo/`
- local backends use prefixes such as `ollama/`, `lmstudio/`, and `vllm/`

The shipped default Codex model is `openai-codex/gpt-5-codex`.

Examples:

```text
/model set openai-codex/gpt-5-codex
/model list codex
/model default openai-codex/gpt-5-codex
/model list anthropic
/model set anthropic/claude-sonnet-4-6
/model list openrouter
/model set openrouter/anthropic/claude-sonnet-4
/model list mistral
/model set mistral/mistral-large-latest
/model list huggingface
/model set huggingface/meta-llama/Llama-3.1-8B-Instruct
/model list gemini
/model set gemini/gemini-2.5-pro
/model list deepseek
/model set deepseek/deepseek-chat
/model list xai
/model set xai/grok-3
/model list kilo
/model set kilo/anthropic/claude-sonnet-4.6
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
  `anthropic/...` model, an `openrouter/...` model, a `mistral/...` model, a
  `huggingface/...` model, a `gemini/...` model, a `deepseek/...` model, a
  `xai/...` model, a `kilo/...` model, or a local backend model such as
  `ollama/...`
- `/agent model <name>` sets the persistent model for the current session agent
- `/model set <name>` is a session-only override
- `/model clear` removes the session override and falls back to the agent or
  global default
- `/model default [name]` shows or sets the global default model for new
  sessions
- `/model info` shows the effective, session, agent, and default models

## Model Info And Usage

`/model info` also reports known model metadata when HybridClaw can resolve it:
context window, maximum output tokens, capability flags, pricing per 1M tokens,
and source references. Local models and Codex subscription-backed models are
shown as zero-cost in local usage summaries; remote-provider pricing is shown
only when the provider catalog exposes usable pricing metadata.

The admin Models page combines the same metadata with daily and monthly usage
rollups, so operators can sort by context window or monthly usage and compare
spend across active models.

## Allowed Model Lists

- `codex.models` controls the allowed Codex model list shown in selectors and
  status output
- `anthropic.models` controls the allowed Anthropic model list shown in
  selectors and status output
- `openrouter.models` controls the allowed OpenRouter model list shown in
  selectors and status output
- `mistral.models` controls the allowed Mistral model list shown in selectors
  and status output
- `huggingface.models` controls the allowed Hugging Face model list shown in
  selectors and status output
- `gemini.models`, `deepseek.models`, `xai.models`, `zai.models`,
  `kimi.models`, `minimax.models`, `dashscope.models`, `xiaomi.models`, and
  `kilo.models` control the allowed model lists for their respective providers
- HybridAI model lists are refreshed from the configured HybridAI base URL
  (`/models`, then `/v1/models` as a compatibility fallback), and discovered
  `context_length` values feed status and model-info output when the API
  exposes them
- Anthropic model lists are discovered at runtime when the provider is enabled
  and Anthropic credentials are available. Discovery responses are cached for
  one hour and fall back to `anthropic.models` when the provider cannot return
  a current list.

## Provider Routing

- when the selected model starts with `openai-codex/`, HybridClaw resolves
  OAuth credentials through the Codex provider instead of `HYBRIDAI_API_KEY`
- when the selected model starts with `anthropic/`, HybridClaw resolves
  credentials through `ANTHROPIC_API_KEY` or the configured Claude CLI method
- when the selected model starts with `openrouter/`, HybridClaw resolves
  credentials through `OPENROUTER_API_KEY`
- when the selected model starts with `mistral/`, HybridClaw resolves
  credentials through `MISTRAL_API_KEY`
- when the selected model starts with `huggingface/`, HybridClaw resolves
  credentials through `HF_TOKEN`
- when the selected model starts with `gemini/`, HybridClaw resolves
  credentials through `GOOGLE_API_KEY` or `GEMINI_API_KEY`
- when the selected model starts with `deepseek/`, HybridClaw resolves
  credentials through `DEEPSEEK_API_KEY`
- when the selected model starts with `xai/`, HybridClaw resolves
  credentials through `XAI_API_KEY`
- when the selected model starts with `zai/`, HybridClaw resolves
  credentials through `GLM_API_KEY` or `ZAI_API_KEY`
- when the selected model starts with `kimi/`, HybridClaw resolves
  credentials through `KIMI_API_KEY`
- when the selected model starts with `minimax/`, HybridClaw resolves
  credentials through `MINIMAX_API_KEY`
- when the selected model starts with `dashscope/`, HybridClaw resolves
  credentials through `DASHSCOPE_API_KEY`
- when the selected model starts with `xiaomi/`, HybridClaw resolves
  credentials through `XIAOMI_API_KEY`
- when the selected model starts with `kilo/`, HybridClaw resolves
  credentials through `KILOCODE_API_KEY` or `KILO_API_KEY`

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
