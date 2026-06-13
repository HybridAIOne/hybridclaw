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

If a reachable gateway is already running in host mode, `hybridclaw tui`
follows that active sandbox mode during preflight, so you do not need to flip
local config first just to attach the TUI.

Then use the TUI slash commands:

```text
/mcp list
/mcp add                # guided wizard: name, transport, URL/command, auth
/mcp edit <name>        # re-run the wizard prefilled with the saved config
/mcp toggle filesystem
/mcp reconnect filesystem
/mcp remove filesystem
```

`/mcp add` (without a JSON payload) starts an interactive wizard that asks for
the transport, the URL or command, and the authentication method. The raw form
`/mcp add <name> <json>` still works for scripted setups.

Enabled MCP tools show up in prompts as namespaced tool names such as
`filesystem__read_file` or `github__list_issues`.

These `mcp list|add|remove|toggle|reconnect` commands update
`~/.hybridclaw/config.json` and hot-reload future turns.

## OAuth for remote MCP servers

Remote `http`/`sse` servers that require OAuth (Linear, Notion, Sentry, and
other hosted MCP servers) can be connected without handling tokens manually.
Set `"auth": "oauth"` on the server — the wizard offers this as the default
for remote servers — then log in:

```text
/mcp add                # choose http transport, then "OAuth"
/mcp login <name>       # opens the provider's consent page in your browser
/mcp status <name>      # shows connected / expired / login required
/mcp logout <name>      # clears the stored credentials
```

The gateway performs the full OAuth 2.1 flow on the host: it discovers the
authorization server (RFC 9728/8414), registers a client dynamically
(RFC 7591), runs the PKCE authorization-code exchange through
`/api/mcp/oauth/callback`, and stores tokens encrypted at rest in the runtime
secret store (`~/.hybridclaw/credentials.json`, one `MCP_OAUTH_*` entry per
server). A fresh `Authorization` header is injected into the container's
MCP config on every turn, and tokens are refreshed automatically.

The same flow is available in the web console on the MCP page via the
**Connect** button, and from chat channels with `/mcp login <name>` (the
authorization URL is printed for you to open).

If the authorization server does not support dynamic client registration,
configure the server with a static header instead:
`{"transport":"http","url":"https://...","headers":{"Authorization":"Bearer <token>"}}`.
