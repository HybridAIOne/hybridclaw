---
title: Local Providers
description: Configure HybridClaw for LM Studio, llama.cpp, Ollama, or vLLM and run the gateway in host mode.
sidebar_position: 2
---

# Local Providers

If LM Studio is serving `qwen/qwen3.5-9b` on `http://127.0.0.1:1234`, the
quickstart looks like this:

```bash
hybridclaw auth login local lmstudio qwen/qwen3.5-9b --base-url http://127.0.0.1:1234
hybridclaw gateway restart --foreground --sandbox=host
hybridclaw gateway status
hybridclaw tui
```

Inside the TUI:

```text
/model list
/model set lmstudio/qwen/qwen3.5-9b
/model info
```

## Other Backends

```bash
hybridclaw auth login local ollama llama3.2
hybridclaw auth login local llamacpp Meta-Llama-3-8B-Instruct --base-url http://127.0.0.1:8081
hybridclaw auth login local vllm mistralai/Mistral-7B-Instruct-v0.3 --base-url http://127.0.0.1:8000 --api-key secret
```

## Multiple vLLM Endpoints

Use `--name` to configure additional endpoints of the same backend type. The
endpoint name becomes the model prefix:

```bash
hybridclaw auth login local vllm Qwen/Qwen3.6-27B-FP8 --name haigpu1 --base-url http://haigpu1:8000 --api-key qwen-secret --thinking-format qwen
hybridclaw auth login local vllm google/gemma-4-e4b-it --name haigpu2 --base-url http://haigpu2:8000 --api-key gemma-secret --tool-call-format gemma --no-default
```

Then select or route models by endpoint name:

```text
/model set haigpu1/Qwen/Qwen3.6-27B-FP8
/config set auxiliaryModels.compression.provider vllm
/config set auxiliaryModels.compression.model haigpu2/google/gemma-4-e4b-it
```

Named endpoints are stored in `local.endpoints[]` with `name`, `type`,
`enabled`, `baseUrl`, optional `apiKey`, and optional `modelBehavior`. Use
`modelBehavior.thinkingFormat: "qwen"` for Qwen thinking markup handling and
`modelBehavior.toolCallFormat: "gemma"` for Gemma tool-call formatting. API
keys provided through the CLI are stored in the encrypted runtime secret store
and referenced from config.

For host-served local backends, restart the gateway with `--sandbox=host` so
the runtime can reach those local endpoints directly.

## Notes

- LM Studio should generally be configured with a `/v1` base URL.
- The model id is optional on `hybridclaw auth login local <backend> [model-id]`.
  If you omit it, HybridClaw enables the backend and you can choose a model
  later with `/model list <backend>`.
- Interactive onboarding can skip remote-provider auth completely when you plan
  to use a local backend only.
- For longer agent sessions, `16k` context is a minimum and `32k` is safer.
- The TUI and Discord model pickers come from the live gateway model list, so
  restart the gateway after enabling a new backend or loading a different
  local model.
