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

For host-served local backends, restart the gateway with `--sandbox=host` so
the runtime can reach those local endpoints directly.

## Notes

- LM Studio should generally be configured with a `/v1` base URL.
- For longer agent sessions, `16k` context is a minimum and `32k` is safer.
- The TUI and Discord model pickers come from the live gateway model list, so
  restart the gateway after enabling a new backend or loading a different
  local model.
