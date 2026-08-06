---
title: Admin Console
description: Manage channels, connectors, agents, human distillation, network policy, settings, secrets, output guard, audit, jobs, and browser-based operator workflows from /admin.
sidebar_position: 10
---

# Admin Console

If the gateway is already running, open
`http://127.0.0.1:9090/admin` when you want browser-based operator workflows
instead of the CLI. The channel setup page lives at `/admin/channels`, and the
agent prompt-file editor lives at `/admin/agents`. The Network Policy page at
`/admin/network-policy` shows live pending approvals and lets operators add,
edit, and delete the current workspace network policy rules for a selected
agent.
The connector setup page at `/admin/connectors` manages HybridAI, Google
Workspace, GitHub, and Microsoft 365 connection flows.
The human distillation page at `/admin/distill` manages subjects, consent,
corpus documents, source uploads, and distillation runs.
The Federation page at `/admin/federation` combines peer trust, fleet topology,
and the instance-wide A2A inbox. It uses the same web-console authentication as
the rest of `/admin`: `WEB_API_TOKEN` when configured, or loopback-only local
web access. The Credentials page at `/admin/credentials` combines write-only
secret management with scoped gateway API tokens.

## Navigation And Settings Search

The sidebar groups the operator surface by job: Overview, Agents,
Connectivity, Models, Security, System, and Labs. Related workflows share a
tabbed page instead of competing for separate sidebar entries:

- Activity combines usage, sessions, and audit
- Agents combines the scoreboard and workspace files
- Automation combines the work queue and schedules
- Federation combines the A2A inbox, peer trust, and fleet topology
- Credentials combines secrets and scoped API tokens
- Extensions combines plugins and tools

Legacy URLs such as `/admin/audit`, `/admin/scheduler`, `/admin/a2a-trust`,
`/admin/secrets`, and `/admin/plugins` redirect to their matching tab, so saved
links continue to land on the intended workflow.

Use the Search control in the sidebar, `Cmd+K` on macOS, or `Ctrl+K` on other
platforms to find both pages and individual runtime settings. Search accepts
labels, descriptions, and dotted config paths. Selecting a result opens the
exact setting on `/admin/config`, or the canonical owner page when a focused
surface such as Channels, Providers, Automation, or Output Guard manages it.
The Settings page also supports section and text filters and protects unsaved
changes before navigation.

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
- `/admin/agents` combines the agent scoreboard and workspace files behind
  tabs with a shared active-agent selector
- `/admin/agents` archives non-default agents without deleting their files or
  history and removes archived agents from console selectors until restored
- `/admin/agents` shows saved revisions for those markdown files and can
  restore an earlier version without opening the workspace directory manually
- `/admin/agents` lists synced installation- and company-scoped cloud memory under a separate "Shared memory" group as read-only cache views without save or revision actions
- `/admin/agents` also shows org-chart/team-structure revisions, per-revision diffs, and a restore action for rolling back role, reporting, delegation, and peer relationships
- `/admin/distill` creates distillation subjects, records consent artefacts,
  registers or uploads source material, manages corpus documents, starts runs,
  and opens generated run reports
- `/admin/network-policy` shows unresolved approval prompts across sessions and
  the selected agent workspace's current `policy.yaml` network rules in one
  place
- `/admin/network-policy` can add, edit, and delete network rules without switching
  to the CLI or editing `policy.yaml` by hand
- `/admin/network-policy` can also change the workspace network default between
  `deny` and `allow`
- `/admin/network-policy` can apply bundled network policy templates from the
  browser
- `/admin/federation?tab=inbox` lists A2A threads by most recent message and opens each thread with sender, recipient, timestamp, intent, and content
- `/admin/federation?tab=inbox` is read-only
- `/admin/federation?tab=topology` shows the local instance id, version, public-key
  fingerprint, child instance reachability, Agent Card latency, and peer
  version when the child is reachable
- `/admin/federation?tab=peers` adds, edits, and removes trusted peers and initiates operator pairing: fetch the peer Agent Card by URL or canonical DNS identifier, preview its identity and public-key fingerprint, then trust the peer with an optional peer-side approval prompt and audit-trail reason
- `/admin/federation?tab=peers` lists incoming pairing requests received through the rate-limited `/a2a/pairing/requests` endpoint and lets operators approve or decline each request with a decision reason
- `/admin/gateway` can reload runtime config and refresh secrets from the
  browser without tearing down the enclosing workspace container
- `/admin/gateway` shows the configured public URL and current tunnel provider
  status for managed ngrok, Tailscale Funnel, or Cloudflare Tunnel exposure
- `/admin/config` edits runtime settings through structured controls for
  booleans, numbers, one-of selections, arrays, and nested config paths, with
  unsaved-change protection and validation before save
- `/admin/config` is generated from the runtime setting registry, supports
  section and free-text filtering, and links settings owned by focused pages to
  those canonical workflows instead of rendering a second editor
- `/admin/models` combines provider health and default-model selection with
  enablement, endpoint, auth method, and SecretRef configuration for hosted and
  local providers
- `/admin/credentials?tab=secrets` lists stored and declared-but-empty secrets by metadata
  only, supports overwrite and unset actions, and never returns cleartext
  secret values to the browser
- `/admin/credentials?tab=api-tokens` lists scoped API token metadata, creates one-time-revealed
  tokens, supports role presets or explicit actions, applies expiry presets,
  and revokes tokens without exposing token secrets after creation
- `/admin/output-guard` configures plugin-backed response classification,
  guard rules, blocked terms, rewrite behavior, and model/provider settings
  without editing runtime config by hand
- PDF previews opened from console file and artifact surfaces render through
  browser-backed `blob:` iframes under the console Content Security Policy
- `/admin/activity?tab=audit` includes filter and search controls for audit event types,
  actors, resources, date ranges, and text queries, including onboarding
  lifecycle events from first-run hatching
- `/admin/activity?tab=audit` and local `/audit turn` or `/audit run` commands can inspect
  focused turn traces when a single request needs debugging
- `/admin/automation?tab=work-queue` shows richer job rows with status, queue, owner, budget, and
  schedule context while keeping navigation inside the SPA
- `/admin/automation?tab=schedules` edits scheduled jobs through the shared form controls and
  surfaces validation errors before saving
- `/admin/connectors` manages HybridAI API-key setup, Google Workspace OAuth,
  HybridAI-managed GitHub and Microsoft 365 connectors, and connector health
  tests from one browser surface
- `/admin/skills` shows catalog metadata, blocked-skill review controls,
  dependency/setup information, and adaptive-skill amendment review
- `/admin/activity?tab=usage` shows activity trends, token totals, cost estimates, and
  channel breakdowns across selectable date ranges
- `/admin/agents?tab=scoreboard` shows observed agent skill scores, best skills,
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
- the web chat route supports explicit agent addressing with autocomplete,
  avatar-backed mention pills, and stable addressed-agent routing
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
- you want to distill a consented coworker agent from source material without
  stitching CLI commands together by hand
- you want to inspect pending approvals on the Network Policy page and compare
  them with the declarative policy without switching to `/chat` or opening the
  workspace files
- you want to add, edit, or remove network policy rules from the browser
- you want to inspect A2A coordination threads without impersonating a recipient agent
- you want to check child-instance reachability or update A2A trust-ledger peers
  from a browser
- you want to pair this instance with a peer instance or review incoming pairing requests without editing the trust ledger by hand
- you want to search and filter audit events without writing SQL or reading
  JSONL logs directly
- you want to adjust output guard behavior or inspect blocked-skill state
  without hand-editing config files
- you want to overwrite or unset a runtime secret without exposing its current
  value to the browser
- you want to create or revoke scoped gateway API tokens without editing
  runtime config or sharing a broad bearer token
- you want explicit browser confirmation before destructive operator actions
- you want to reload runtime config and secrets from `/admin/gateway` without
  switching back to the CLI
- you want to connect HybridAI, Google Workspace, GitHub, or Microsoft 365 from
  the browser and test the resulting connector state
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
- [A2A Peer Pairing](../guides/a2a-peer-pairing.md)
