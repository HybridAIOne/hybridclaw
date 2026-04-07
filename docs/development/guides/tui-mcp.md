---
title: TUI MCP Quickstart
description: Run host-dependent MCP servers and manage them directly from the TUI.
sidebar_position: 3
---

# TUI MCP Quickstart

For stdio MCP servers that depend on host binaries such as `docker`, `node`,
or `npx`, start the gateway in host sandbox mode:

```bash
hybridclaw gateway start --foreground --sandbox=host
hybridclaw tui
```

Then use the TUI slash commands:

```text
/mcp list
/mcp add filesystem {"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/Users/you/project"],"enabled":true}
/mcp toggle filesystem
/mcp reconnect filesystem
/mcp remove filesystem
```

Enabled MCP tools show up in prompts as namespaced tool names such as
`filesystem__read_file` or `github__list_issues`.

These `mcp list|add|remove|toggle|reconnect` commands update
`~/.hybridclaw/config.json` and hot-reload future turns.
