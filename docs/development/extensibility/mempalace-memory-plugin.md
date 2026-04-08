---
title: MemPalace Memory Plugin
description: Setup and behavior for the bundled `mempalace-memory` plugin that injects MemPalace wake-up and search context.
sidebar_position: 6
---

# MemPalace Memory Plugin

HybridClaw ships a bundled MemPalace plugin at
[`plugins/mempalace-memory`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/mempalace-memory).

The plugin is read-oriented:

- runs `mempalace wake-up` before prompts to inject MemPalace Layer 0/1 context
- runs `mempalace search "<latest user question>"` to recall relevant verbatim memories
- exposes a `/mempalace ...` command for manual inspection inside TUI/web sessions

## Install

```bash
hybridclaw plugin install ./plugins/mempalace-memory
hybridclaw plugin config mempalace-memory command mempalace
```

From a live session:

```text
/plugin install ./plugins/mempalace-memory
/plugin config mempalace-memory command mempalace
/plugin reload
```

If your palace lives somewhere non-default, set `palacePath`:

```text
/plugin config mempalace-memory palacePath ~/.mempalace/palace
```

## Useful Config

```json
{
  "plugins": {
    "list": [
      {
        "id": "mempalace-memory",
        "enabled": true,
        "config": {
          "command": "mempalace",
          "palacePath": "~/.mempalace/palace",
          "wakeUpWing": "hybridclaw",
          "maxResults": 3
        }
      }
    ]
  }
}
```

Key settings:

- `command`: path to the MemPalace executable
- `palacePath`: optional override for `--palace`
- `wakeUpWing`: optional wing passed to `mempalace wake-up --wing ...`
- `searchWing` / `searchRoom`: optional filters applied to automatic search
- `wakeUpEnabled` / `searchEnabled`: toggle either injection stage independently

## Runtime Behavior

- startup: runs `mempalace status` as a health check
- prompt build: injects cleaned `wake-up` output and search results for the most
  recent user message
- command surface: `/mempalace status`, `/mempalace wake-up`, `/mempalace search ...`

The plugin does not write back into MemPalace. Use MemPalace's own mining and
hook flows to populate the palace, then let HybridClaw recall from it.
