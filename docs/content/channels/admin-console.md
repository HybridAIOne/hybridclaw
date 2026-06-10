---
title: Admin Console
description: Manage channels, agents, approvals, config, secrets, output guard, audit, jobs, and browser-based operator workflows from /admin.
sidebar_position: 10
---

# Admin Console

If the gateway is already running, open
`http://127.0.0.1:9090/admin` when you want browser-based operator workflows
instead of the CLI. The channel setup page lives at `/admin/channels`, and the
agent prompt-file editor lives at `/admin/agents`. The approvals page at
`/admin/approvals` shows live pending approvals and lets operators add, edit,
and delete the current workspace network policy rules for a selected agent.
The A2A inbox at `/admin/a2a-inbox` shows instance-wide agent-to-agent message threads and uses the same web-console authentication as the rest of `/admin`: `WEB_API_TOKEN` when configured, or loopback-only local web access.
The fleet page at `/admin/fleet-topology` shows the local A2A instance identity
and trusted child instances from the A2A trust ledger.

## What The Admin Console Can Do

- `/admin/channels` shows each transport as `active`, `configured`, or
  `available`
- `/admin/channels` edits Discord, Slack, Telegram, Signal, WhatsApp, email,
  Microsoft Teams, iMessage, and Twilio voice settings from one place
- `/admin/channels` can start the Signal linked-device QR flow when
  `signal-cli` is installed on the gateway host. HybridClaw Cloud gateway
  images include `signal-cli` on amd64 hosts.
- `/admin/channels` saves `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`,
  `SLACK_APP_TOKEN`, `TELEGRAM_BOT_TOKEN`, `EMAIL_PASSWORD`, and
  `IMESSAGE_PASSWORD` through the same encrypted runtime secret store used by
  the CLI, plus `TWILIO_AUTH_TOKEN` for the voice channel
- `/admin/channels` lets operators edit channel-specific instruction text that
  is injected into the runtime prompt as transport guidance
- `/admin/channels` shows the live WhatsApp pairing QR when the transport is
  enabled but not linked yet
- `/admin/agents` lets operators pick any registered agent and edit the
  allowlisted workspace bootstrap markdown files seeded into that agent's
  runtime workspace
- `/admin/agents/overview` shows the registered agent fleet with model,
  budget, prompt-file, workspace, and channel metadata for quick comparison
- `/admin/agents` shows saved revisions for those markdown files and can
  restore an earlier version without opening the workspace directory manually
- `/admin/agents` also shows org-chart/team-structure revisions, per-revision diffs, and a restore action for rolling back role, reporting, delegation, and peer relationships
- `/admin/approvals` shows unresolved approval prompts across sessions and the
  selected agent workspace's current `policy.yaml` network rules in one place
- `/admin/approvals` can add, edit, and delete network rules without switching
  to the CLI or editing `policy.yaml` by hand
- `/admin/approvals` can also change the workspace network default between
  `deny` and `allow`
- `/admin/approvals` can apply bundled network policy templates from the
  browser
- `/admin/a2a-inbox` lists A2A threads by most recent message and opens each thread with sender, recipient, timestamp, intent, and content
- `/admin/a2a-inbox` is read-only
- `/admin/fleet-topology` shows the local instance id, version, public-key
  fingerprint, child instance reachability, Agent Card latency, and peer
  version when the child is reachable
- `/admin/fleet-topology` can add, edit, and remove trusted A2A child
  instances by peer id, Agent Card URL, delivery URL, public-key fingerprint or
  JWK, and trust reason
- `/admin/gateway` can reload runtime config and refresh secrets from the
  browser without tearing down the enclosing workspace container
- `/admin/gateway` shows the configured public URL and current tunnel provider
  status for managed ngrok, Tailscale Funnel, or Cloudflare Tunnel exposure
- `/admin/config` edits runtime settings through structured controls for
  booleans, numbers, one-of selections, arrays, and nested config paths, with
  unsaved-change protection and validation before save
- `/admin/secrets` lists stored and declared-but-empty secrets by metadata
  only, supports overwrite and unset actions, and never returns cleartext
  secret values to the browser
- `/admin/output-guard` configures plugin-backed response classification,
  guard rules, blocked terms, rewrite behavior, and model/provider settings
  without editing runtime config by hand
- `/admin/audit` includes filter and search controls for audit event types,
  actors, resources, date ranges, and text queries
- `/admin/audit` and local `/audit turn` or `/audit run` commands can inspect
  focused turn traces when a single request needs debugging
- `/admin/jobs` shows richer job rows with status, queue, owner, budget, and
  schedule context while keeping navigation inside the SPA
- `/admin/scheduler` edits scheduled jobs through the shared form controls and
  surfaces validation errors before saving
- `/admin/skills` shows catalog metadata, blocked-skill review controls,
  dependency/setup information, and adaptive-skill amendment review
- `/admin/statistics` shows activity trends, token totals, cost estimates, and
  channel breakdowns across selectable date ranges
- `/admin/agent-scoreboard` shows observed agent skill scores, best skills,
  reliability, timing, and links to generated `CV.md` files
- admin forms share common checkbox, combobox, date, field, input,
  native-select, number, radio, switch, textarea, validation, draft, and
  unsaved-change components so behavior is consistent across pages
- pages that show owned work can render per-agent budget chips, including
  neutral, warning, and over-budget states when USD/EUR or token budgets are
  configured
- the web chat route shares the admin shell, supports improved session
  management, preserves scroll position while reading older messages, and
  renders assistant message blocks with better structured content handling
- the web chat route renders slash-command results distinctly and lets
  operators apply persisted thumbs-up/down ratings to assistant responses
- the web chat route syntax-highlights completed code blocks, shows language
  labels, and keeps copy controls reachable on hover and touch devices
- destructive admin actions use explicit browser confirmation dialogs before
  HybridClaw applies the requested change

Channel edits in `/admin/channels` write the same runtime config that
`hybridclaw channels ... setup`, `hybridclaw auth login ...`, `/config set`,
and `/secret set` use.

Agent-file edits in `/admin/agents` update the selected agent's shipped
workspace bootstrap files such as `AGENTS.md`. The editor is intentionally
scoped to the built-in allowlist and is not a general workspace file browser.

## When To Prefer The Admin Console

- you want to compare transport status before editing anything
- you prefer browser forms to long CLI flag lists
- you need the WhatsApp pairing QR in a browser instead of a terminal
- you want to tune per-channel instructions such as spoken-style guidance for
  voice without editing prompt files
- you want to verify saved settings without editing `config.json` directly
- you want to update an agent's workspace instructions from the browser
- you want revision history before restoring an earlier agent prompt file
- you want to inspect or roll back agent org-chart changes from the browser
- you want to compare all agents, models, budgets, and prompt metadata from a
  single overview page
- you want to inspect pending approvals and compare them with the declarative
  network policy without switching to `/chat` or opening the workspace files
- you want to add, edit, or remove network policy rules from the browser
- you want to inspect A2A coordination threads without impersonating a recipient agent
- you want to check child-instance reachability or update A2A trust-ledger peers
  from a browser
- you want to search and filter audit events without writing SQL or reading
  JSONL logs directly
- you want to adjust output guard behavior or inspect blocked-skill state
  without hand-editing config files
- you want to overwrite or unset a runtime secret without exposing its current
  value to the browser
- you want explicit browser confirmation before destructive operator actions
- you want to reload runtime config and secrets from `/admin/gateway` without
  switching back to the CLI
- you want to verify the active public URL or tunnel state before sharing a
  remote access link
- you want to monitor usage, cost, and channel activity without querying the
  database directly
- you want to compare agents by observed skill performance before assigning
  production work

## Related Pages

- [Overview](./overview.md)
- [Local Config And Secrets](./local-config-and-secrets.md)
- [Policies And Allowlists](./policies-and-allowlists.md)
