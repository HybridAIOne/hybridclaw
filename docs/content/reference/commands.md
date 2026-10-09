---
title: Commands
description: High-value CLI, gateway, agent, skill, plugin, and audit commands.
sidebar_position: 5
---

# Commands

## Core Runtime

```bash
hybridclaw --version
hybridclaw gateway start [--foreground] [--debug] [--log-requests] [--debug-model-responses] [--system-prompt=<parts|none>] [--tools=full|none] [--no-tools] [--sandbox=container|host]
hybridclaw gateway restart [--foreground] [--debug] [--log-requests] [--debug-model-responses] [--system-prompt=<parts|none>] [--tools=full|none] [--no-tools] [--sandbox=container|host]
hybridclaw gateway stop
hybridclaw gateway status
hybridclaw gateway sessions [active|clear-active|prune --older-than <duration> [--dry-run|--confirm]]
hybridclaw gateway bot info
hybridclaw gateway voice info
hybridclaw gateway voice call <number>
hybridclaw gateway show [all|thinking|tools|none]
hybridclaw gateway <command...>
hybridclaw gateway compact
hybridclaw gateway memory inspect [sessionId]
hybridclaw gateway reset [yes|no]
hybridclaw tui
hybridclaw tui --resume <sessionId>
hybridclaw --resume <sessionId>
hybridclaw onboarding
hybridclaw doctor [--fix|--json|<component>]
hybridclaw help <topic>
hybridclaw config
hybridclaw config check
hybridclaw config reload
hybridclaw config get <key>
hybridclaw config set <key> <value>
hybridclaw config revisions [list|rollback <id>|delete <id>|clear]
hybridclaw token list
hybridclaw token create --label <label> (--role <role>|--actions <a,b>) [--expires-at <iso>]
hybridclaw token revoke <id>
hybridclaw browser login [--url <url>]
hybridclaw browser status
hybridclaw browser reset
hybridclaw browser-pool doctor
hybridclaw gateway concierge [info]
hybridclaw update [status|--check] [--yes]
hybridclaw help
```

`hybridclaw gateway <command...>` forwards a command to a running gateway, for
example `sessions` or `bot info`.
`gateway compact` archives older session history into memory while preserving a
recent active tail, and `gateway reset [yes|no]` clears history plus the
current workspace after confirmation.
`gateway memory inspect [sessionId]` is a local diagnostic that shows the
current built-in memory layers for a session: `MEMORY.md`, today's daily note,
recent raw history, compacted `session_summary`, recent semantic-memory rows,
and canonical cross-session recall state.
`hybridclaw gateway status` reports the current sandbox/runtime state; in
container mode it also shows the configured image name, resolved image
version, and short image id when available.
`hybridclaw tui --resume <sessionId>` and `hybridclaw --resume <sessionId>`
reopen an earlier TUI session by canonical session id.
`gateway voice info` reports the current local Twilio voice setup, and
`gateway voice call <number>` places an outbound call through the configured
Twilio account.
Use `--debug-model-responses` only for local troubleshooting; it writes raw
provider response diagnostics and the last prompt under the HybridClaw data
directory. Use `--system-prompt=<parts|none>` and `--tools=full|none` for
local eval and prompt-surface experiments.
`hybridclaw config get <key>` prints one resolved dotted runtime config value,
which is useful when checking active settings without dumping the whole config
file.

## Scoped API Tokens

Scoped gateway API tokens are for local API clients, automation, and delegated
operator workflows that should not share a broad `WEB_API_TOKEN` or
`GATEWAY_API_TOKEN`.

```bash
hybridclaw token list
hybridclaw token create --label "local evals" --role admin.viewer --expires-at 2026-08-01T00:00:00Z
hybridclaw token create --label "chat client" --actions openai.api,chat.send
hybridclaw token revoke <token-id>
```

- token values start with `hck_` and are shown only once at creation time
- `token list` shows metadata, status, expiry, last use, and claims; it never
  returns token secrets
- `--role` accepts admin RBAC role bundles such as `admin.viewer`,
  `admin.security_manager`, or `admin.full`
- `--actions` accepts explicit action names such as `openai.api`,
  `chat.send`, `voice.session`, `status.read`, `admin.tokens.read`,
  `admin.tokens.create`, and `admin.tokens.revoke`
- `/admin/credentials?tab=api-tokens` provides the same create/list/revoke workflow in the browser
  with role presets, action filters, and expiry presets

Device clients can request a short pairing code without copying an administrator's
token. Approve the code in **Credentials → Devices**; the resulting API token is
scoped to `chat.send`, `agents.read`, and `artifacts.read` and can be revoked in
**Credentials → API tokens**. See [device pairing](../guides/web-notifications.md#pairing-a-device).

## OpenAI-Compatible API

The running gateway serves an OpenAI-compatible loopback API:

```bash
curl http://127.0.0.1:9090/v1/models

curl http://127.0.0.1:9090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <WEB_API_TOKEN>' \
  -d '{"model":"hybridai/gpt-4.1-mini","messages":[{"role":"user","content":"Hello"}]}'
```

- `/v1/models` and `/v1/chat/completions` use the same local gateway process;
  they are not a separate service
- requests must include `Authorization: Bearer <token>`; loopback address alone
  does not authenticate API requests. Accepted credentials are a scoped `hck_`
  token carrying the `openai.api` action (preferred), `WEB_API_TOKEN`, or
  `GATEWAY_API_TOKEN`
- without an agent selection the turn runs as the configured default agent
  (`agents.defaultAgentId`), falling back to the built-in `main` agent.
  Select one by appending `__hc_eval=agent=<agent-id>` to the model id or
  sending `X-HybridClaw-Eval-Profile: agent=<agent-id>` — which also marks the
  request as an eval request and auto-approves that turn's tool calls
- each request runs in a fresh session; earlier entries in `messages` are
  replayed as history for that turn and nothing persists between calls
- delegated chat completions return an acknowledgement and include
  `hybridclaw.delegation` with `{ "id": "<completion-id>", "status": "queued" }`;
  non-streaming responses also set `X-HybridClaw-Delegation-Id`
- delegated streaming completions carry the same `hybridclaw.delegation`
  object on the final stop chunk
- poll `GET /v1/chat/completions/{completion-id}` to retrieve delegated job
  state; responses include top-level `status` with one of `queued`,
  `in_progress`, `completed`, `failed`, or `cancelled`
- while a delegated job is queued or running, retrieval returns the original
  acknowledgement with `finish_reason: null`; when completed, it returns the
  synthesized final answer with `finish_reason: "stop"`; failed jobs include a
  top-level OpenAI-shaped `error`
- polling intervals around 1-5 seconds are appropriate for delegated jobs,
  which may wait behind the delegation concurrency limit before running
- the same endpoints serve external integrations over a reachable HTTPS
  hostname; see [OpenAI-Compatible API](../guides/openai-compatible-api.md) for
  the token, agent-selection, and delegation-polling details a third-party
  caller needs

## Auth And Providers

```bash
hybridclaw auth login
hybridclaw auth login hybridai [--device-code|--browser|--api-key|--import] [--base-url <url>]
hybridclaw auth login codex [--device-code|--browser|--import]
hybridclaw auth login anthropic [model-id] [--method <api-key|claude-cli>] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login openrouter [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login mistral [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login huggingface [model-id] [--api-key <token>] [--base-url <url>] [--no-default]
hybridclaw auth login google [--client-id <id>] [--client-secret <secret>] [--account <email>] [--scopes <scopes>] [--refresh-token <token>] [--redirect-port <port>]
hybridclaw auth login microsoft365 [--client-id <id>] [--client-secret <secret>] [--tenant-id <tenant>] [--account <label>] [--scopes <scopes>] [--refresh-token <token>] [--redirect-port <port>]
hybridclaw auth login gemini [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login deepseek [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login xai [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login zai [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login kimi [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login minimax [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login dashscope [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login xiaomi [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login kilo [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
hybridclaw auth login local <ollama|lmstudio|llamacpp|vllm> [model-id] [--name <endpoint>] [--base-url <url>] [--api-key <key>] [--thinking-format qwen] [--no-default]
hybridclaw auth login msteams [--app-id <id>|--client-id <id>] [--app-password <secret>|--client-secret <secret>] [--tenant-id <id>]
hybridclaw auth login slack [--bot-token <xoxb...>] [--app-token <xapp...>]
hybridclaw auth status <provider>
hybridclaw auth logout <provider>
hybridclaw auth whatsapp reset
hybridclaw help hybridai
hybridclaw help codex
hybridclaw help anthropic
hybridclaw help openrouter
hybridclaw help mistral
hybridclaw help huggingface
hybridclaw help auth
hybridclaw help gemini
hybridclaw help deepseek
hybridclaw help xai
hybridclaw help zai
hybridclaw help kimi
hybridclaw help minimax
hybridclaw help dashscope
hybridclaw help xiaomi
hybridclaw help kilo
hybridclaw help msteams
hybridclaw help slack
hybridclaw help local
```

`auth status` supports `hybridai`, `codex`, `anthropic`, `openrouter`,
`mistral`, `huggingface`, `google`, `gemini`, `deepseek`, `xai`, `zai`,
`kimi`, `minimax`, `dashscope`, `xiaomi`, `kilo`, `local`, `msteams`, and
`slack`.
`auth login` without a provider runs the same interactive onboarding flow as
`hybridclaw onboarding`.
`auth status` prints local credential-source and config state while redacting
the secret values themselves.
Anthropic supports `--method api-key` for direct Messages API calls and
`--method claude-cli` for the official Claude CLI transport in host sandbox
mode.
Google OAuth credentials for Workspace skills are managed with
`hybridclaw auth login google`; the refresh token and client secret are stored
in encrypted runtime secrets, and agent runtimes receive short-lived access
tokens instead of long-lived refresh tokens.

## Secrets And Routes

Named secrets and gateway-side auth routes are available from both the local
CLI and local TUI/web slash-command surface:

```bash
hybridclaw secret list
hybridclaw secret set <name> <value>
hybridclaw secret status <name>
hybridclaw secret unset <name>
hybridclaw secret route list
hybridclaw secret route add <url-prefix> <secret-name|google-oauth|microsoft-oauth> [header] [prefix|none]
hybridclaw secret route remove <url-prefix> [header]
hybridclaw env list
hybridclaw env set <name> <value>
hybridclaw env show <name>
hybridclaw env unset <name>
```

```text
/secret list
/secret set <name> <value>
/secret status <name>
/secret unset <name>
/secret route list
/secret route add <url-prefix> <secret-name|google-oauth|microsoft-oauth> [header] [prefix|none]
/secret route remove <url-prefix> [header]
/env list
/env set <name> <value>
/env show <name>
/env unset <name>
```

- local-only surface: `/secret ...` is available from local TUI and local web
  chat sessions, not from Discord or other remote channels. A web turn sent
  with a scoped API token, such as a paired phone's, also needs the matching
  `secret.*` action; see
  [Admin Access Control](../developer-guide/admin-access-control.md#local-only-slash-commands)
- `hybridclaw secret status <name>` reports whether the secret is stored; it
  never outputs decrypted values. Secrets are only resolved gateway-side via
  `<secret:NAME>` placeholders or auth rules
- stored secret names must use uppercase letters, digits, and underscores
- built-in provider keys and custom names share the same encrypted
  `~/.hybridclaw/credentials.json` store
- `/secret route add` manages `tools.httpRequest.authRules[]`, which lets the
  gateway inject the real auth header for matching `http_request` tool calls
- use `prefix` for `Bearer <secret>` or `none` for raw header injection
- use `google-oauth` as the secret name for direct Google API routes after
  `hybridclaw auth login google`; see
  [Google OAuth For Direct Google APIs](../getting-started/authentication.md#google-oauth-for-direct-google-apis)
- use `microsoft-oauth` as the secret name for direct Microsoft Graph routes
  after `hybridclaw auth login microsoft365`
- `env` stores plaintext runtime values such as local device hostnames,
  account ids, or usernames for agent helpers. Do not use it for passwords,
  tokens, API keys, or signing material; use encrypted secrets for those.

## Channels

```bash
hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]
hybridclaw channels slack manifest [--format <yaml|json>]
hybridclaw channels slack register-commands [--app-id <A...>] [--config-token <xoxe-...>]
hybridclaw channels discord_webhook setup --webhook-url <https://discord.com/api/webhooks/...> [--target default] [--default-username <name>] [--default-avatar-url <url>]
hybridclaw channels slack_webhook setup --webhook-url <https://hooks.slack.com/services/...> [--target default] [--default-username <name>] [--default-icon-emoji <:emoji:>] [--default-icon-url <url>]
hybridclaw channel add discord_webhook --webhook-url <https://discord.com/api/webhooks/...> [--target default]
hybridclaw channel add slack_webhook --webhook-url <https://hooks.slack.com/services/...> [--target default]
hybridclaw channels telegram setup [--token <token>] [--allow-from <user-id|@username|*>]... [--group-allow-from <user-id|@username|*>]... [--dm-policy <open|allowlist|disabled>] [--group-policy <open|allowlist|disabled>] [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>] [--require-mention|--no-require-mention]
hybridclaw channels signal setup [--daemon-url <url>] --account <+E164|uuid> [--allow-from <+E164|uuid|*>]... [--group-allow-from <+E164|uuid|*>]... [--dm-policy <open|allowlist|disabled>] [--group-policy <open|allowlist|disabled>] [--text-chunk-limit <chars>] [--reconnect-interval-ms <ms>] [--outbound-delay-ms <ms>]
hybridclaw channels threema setup --identity <gateway-id> [--secret <gateway-secret>] [--api-base-url <url>] [--allow-from <threema-target|*>]... [--dm-policy <open|allowlist|disabled>] [--text-chunk-limit <chars>] [--outbound-delay-ms <ms>]
hybridclaw channels imessage setup [--backend <local|remote>] [--allow-from <phone|email|chat:id>]... [--server-url <url>] [--password <password>] [--cli-path <path>] [--db-path <path>] [--webhook-path <path>] [--allow-private-network]
hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...
hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--imap-port <port>] [--imap-secure|--no-imap-secure] [--smtp-host <host>] [--smtp-port <port>] [--smtp-secure|--no-smtp-secure] [--folder <name>]... [--allow-from <email|*@domain|*>]... [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>]
hybridclaw gateway voice info
hybridclaw gateway voice call <number>
hybridclaw auth login msteams [--app-id <id>|--client-id <id>] [--app-password <secret>|--client-secret <secret>] [--tenant-id <id>]
hybridclaw auth login slack [--bot-token <xoxb...>] [--app-token <xapp...>]
```

Microsoft Teams and full Slack setup use `auth login` instead of
`channels setup` because they need app credentials rather than a local pairing
flow. Slack Incoming Webhook and Discord Incoming Webhook setup are
outbound-only and store each webhook URL as an encrypted runtime secret.
Threema uses Gateway Basic mode for outbound text delivery. For the
step-by-step setup guides, see
[Channels: Overview](../channels/overview.md) and
[Connect Your First Channel](../getting-started/first-channel.md).
Twilio voice is configured through `/admin/channels` or direct `voice.*`
config keys, then inspected or used for outbound dialing with
`hybridclaw gateway voice info` and `hybridclaw gateway voice call <number>`.
Local TUI/web sessions can also write channel config and secrets with
`/config set ...` and `/secret set ...`; see
[Channels: Local Config And Secrets](../channels/local-config-and-secrets.md)
for channel-specific examples and current CLI-only limitations such as
WhatsApp pairing.

## Agents And Packages

```bash
hybridclaw agent list
hybridclaw agent config <json|--json <json>> [--activate]
hybridclaw agent export [agent-id] [-o <path>]
hybridclaw agent inspect <file.claw>
hybridclaw agent install <file.claw|https://.../*.claw|official:<agent-dir>|github:owner/repo[/<ref>]/<agent-dir>> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--skip-import-errors] [--yes]
hybridclaw agent activate <agent-id>
hybridclaw agent uninstall <agent-id> [--yes]
hybridclaw gateway agent [list|switch <id>|create <id>|model [name]]
```

`agent export` and `agent install` are the archive verbs. Local TUI/web
sessions also expose `/agent install <source>` for the same archive flows
against a running gateway.
`agent activate <agent-id>` sets the default agent for new requests that do not
pin an agent explicitly.

`agent config` is the JSON provisioning path for generated agents. It upserts
agent metadata directly, can overwrite top-level workspace markdown files, can
set the empty-chat `emptyChatHeader`, and imports `imageAsset` URLs or local
file paths into the agent workspace:

```bash
hybridclaw agent config '{"id":"felix","model":"gpt-5.4-mini","emptyChatHeader":"Ready to clear the support queue?","imageAsset":"https://example.com/felix.jpg","markdown":{"IDENTITY.md":"# Felix\n"}}' --activate
```

Proxy agents use the same command with a per-agent `proxy` object:

```bash
hybridclaw agent config '{"id":"support-proxy","name":"Support Proxy","proxy":{"kind":"hybridai","baseUrl":"https://app.hybridai.one","chatbotId":"bot_abc123","apiKey":"<secret:HYBRIDAI_API_KEY>","conversationScope":"user"}}'
```

Use `agent config` for metadata plus bootstrap markdown. Use `agent install`
when you need a portable `.claw` archive with arbitrary workspace files,
bundled skills, bundled plugins, or install-time imports.

For archive flags such as `--description`, `--author`, skill/plugin bundling,
and GitHub install sources, see
[Agent Packages](../extensibility/agent-packages.md).

## Migration

```bash
hybridclaw migrate openclaw [--source <path>] [--agent <id>] [--dry-run] [--overwrite] [--migrate-secrets] [--force]
hybridclaw migrate hermes [--source <path>] [--agent <id>] [--dry-run] [--overwrite] [--migrate-secrets] [--force]
```

Use these commands to import compatible state from `~/.openclaw` or
`~/.hermes` into a HybridClaw agent workspace. `--dry-run` previews the
workspace, config, model, and secret changes before writing anything.

## Backup And Restore

```bash
hybridclaw backup [--output <path>]
hybridclaw backup restore <archive.zip> [--force]
```

`backup` creates a timestamped zip archive of the HybridClaw runtime home
(`~/.hybridclaw` by default, or `$HYBRIDCLAW_DATA_DIR` when set). SQLite
databases are copied through the SQLite backup API so WAL-mode databases
produce consistent snapshots. Ephemeral state — WAL/SHM sidecars, cache
directories, container image state, evals, migration backups, and PID
files — is excluded. `backup restore` validates the archive manifest and
marker files (`config.json`, `credentials.json`) before replacing any data
and prompts when the target runtime home already exists; pass `--force` to
skip the prompt for scripted disaster-recovery restores.

## Skills, Tools, Plugins, Audit

```bash
hybridclaw skill list
hybridclaw skill enable <skill-name> [--channel <kind>]
hybridclaw skill disable <skill-name> [--channel <kind>]
hybridclaw skill toggle [--channel <kind>]
hybridclaw skill inspect <skill-name>
hybridclaw skill inspect --all
hybridclaw skill runs <skill-name>
hybridclaw skill install <source>
hybridclaw skill install <skill-name> <dependency>
hybridclaw skill upgrade <source>
hybridclaw skill uninstall <skill-name>
hybridclaw skill revisions <skill-name>
hybridclaw skill rollback <skill-name> <revision-id>
hybridclaw skill setup <skill-name>
hybridclaw skill learn <skill-name> [--apply|--reject|--rollback]
hybridclaw skill history <skill-name>
hybridclaw skill sync [--skip-skill-scan] <source>
hybridclaw skill import [--force] [--skip-skill-scan] <source>
hybridclaw tool list
hybridclaw tool enable <tool-name>
hybridclaw tool disable <tool-name>
hybridclaw plugin list
hybridclaw plugin config <plugin-id> [key] [value|--unset]
hybridclaw plugin enable <plugin-id>
hybridclaw plugin disable <plugin-id>
hybridclaw plugin install <path|plugin-id|npm-spec>
hybridclaw plugin reinstall <path|plugin-id|npm-spec>
hybridclaw plugin check <plugin-id>
hybridclaw plugin uninstall <plugin-id>
hybridclaw update [status|--check] [--yes]
hybridclaw audit recent
hybridclaw audit recent session <sessionId> [n]
hybridclaw audit approvals [n] [--denied]
hybridclaw audit search <query>
hybridclaw audit verify <sessionId>
hybridclaw audit verify-usage-batch <batchId>
hybridclaw audit scan-leaks [sessionId] [--quiet|--all] [--level <critical|high|medium|low>] [--type <in,out,tool,url>] [--json]
hybridclaw audit instructions [--sync] [--approve]
```

`skill import [--force] [--skip-skill-scan]` supports packaged `official/<skill-name>` sources plus
community imports from `skills-sh`, `clawhub`, `lobehub`,
`claude-marketplace`, `well-known`, explicit GitHub repo/path refs, local
directories, and `.zip` archives. Locally-imported skills receive personal
trust and persist their import-source marker across restarts.
`skill install <source>` and `skill upgrade <source>` manage packaged skills
with manifest records, audit events, and rollback snapshots. `skill uninstall
<skill-name>` removes a managed package, `skill revisions <skill-name>` lists
recorded snapshots, and `skill rollback <skill-name> <revision-id>` restores
one snapshot.
`skill install <skill-name> <dependency>` runs one declared dependency from the
named skill. `skill setup <skill-name>` runs every declared dependency for that
skill in order. Use `skill list` first to discover the dependency ids exposed by
a skill.
`skill sync [--skip-skill-scan] <source>` is a convenience alias for
`skill import --force <source>` when refreshing an installed skill from the same
source syntax.
`plugin check <plugin-id>` reports dependency, environment, and binary status
for one discovered plugin before or after installation.
`audit scan-leaks` loads rules from `./.confidential.yml` or
`~/.hybridclaw/.confidential.yml`, scans prompt-bearing audit records, prints a
severity summary, and exits with code `2` when matches are found. Use
`--level` to set a minimum severity, `--type` to narrow to inbound prompts,
outbound responses, tool I/O, or URL records, and `--json` for automation.
`audit verify-usage-batch <batchId>` verifies the token-usage batch hash for
buffered usage events. `audit instructions --sync` restores runtime instruction
copies from installed sources; add `--approve` when the instruction audit
workflow requires an explicit approval record.
`update` checks for a newer installed release and can upgrade a global npm
install. When `--yes` completes successfully and a local gateway is already
running with a replayable launch command, HybridClaw restarts it automatically
with the original parameters; otherwise it falls back to manual restart
instructions. Source checkouts receive git-based update instructions instead.

When you start HybridClaw interactively (`hybridclaw tui`, `hybridclaw gateway`,
or `hybridclaw gateway start`) and a newer release is available, HybridClaw
prints the available version and prompts you to update before continuing. Answer
`y` to install the update, or `n` to start on the current version. Installing
exits the current command once the update finishes (the running process still
holds the old code), so relaunch HybridClaw to use the new version; an
already-running gateway is restarted automatically with its original
parameters. This prompt appears only on an interactive terminal and only for
global package installs; non-interactive shells and source checkouts are never
blocked. The registry
check is cached under the runtime home (`version-check.json`, 20-hour TTL) and
refreshed in a detached background process, so startup never waits on the
network — a newly published version surfaces on the next launch.

## Network Policy

```bash
hybridclaw policy status
hybridclaw policy list [--agent <id>] [--json]
hybridclaw policy allow <host> [--agent <id>] [--methods <list>] [--paths <list>] [--port <number|*>] [--comment <text>]
hybridclaw policy deny <host> [--agent <id>] [--methods <list>] [--paths <list>] [--port <number|*>] [--comment <text>]
hybridclaw policy delete <number|host>
hybridclaw policy reset
hybridclaw policy default <allow|deny>
hybridclaw policy preset list
hybridclaw policy preset add <name> [--dry-run]
hybridclaw policy preset remove <name>
```

Policy commands edit the current workspace HTTP/network access policy. Rules
are evaluated in order, first match wins, and bare site-scope hosts such as
`github.com` also match subdomains such as `api.github.com`. Use
`policy list --agent <id>` to show both global rules and rules scoped to a
specific agent.

## Discord And Session Commands

Discord supports `!claw` plus slash-command equivalents for the same core
actions. Common examples:

```text
!claw <message>
/agent
/btw <question>
/agent list
/agent switch <id>
/agent create <id> [--model <model>]
/agent model [name]
!claw bot set <id>
!claw model set <name>
!claw model clear
!claw model info
!claw rag on
!claw compact
/reset
!claw clear
!claw audit recent [n]
!claw audit verify [sessionId]
!claw audit search <query>
!claw audit approvals [n] [--denied]
!claw usage [summary|daily|monthly|model [daily|monthly] [agentId]]
!claw export session [sessionId]
!claw export trace [sessionId|all]
!claw mcp list
!claw mcp add <name> <json>
!claw schedule add "<cron>" <prompt>
!claw schedule add --tz Europe/Berlin "<cron>" <prompt>
!claw schedule add --alert proactive "<cron>" <prompt>
!claw schedule add --reply-only --alert proactive "<cron>" <prompt>
!claw schedule add at "<ISO time>" <prompt>
!claw schedule add every <ms> <prompt>
!claw schedule list
!claw schedule results <id> [--limit <n>]
!claw schedule remove <id>
!claw schedule toggle <id>
```

`schedule` tasks belong to the chat that created them and keep belonging to
it when an idle or daily reset gives the chat a new session. A web chat may
also list, remove and toggle the tasks of other web chats assigned to the same
agent. `schedule results` shows what the task's recent runs answered (20 by
default, at most 200) and only answers the chat that created the task and the
main chat its replies go to, because a run can quote private data. Cron
expressions run in UTC unless `--tz` names an IANA time zone; `--tz` must come
before the schedule.

A web task replies in its agent's main chat: the web chat the HybridAI apps
open with a session id starting with `main-` (the most recently active one, if
there are several). A task created in another web chat of that agent runs
apart, as with `--reply-only`, and its reply is posted to the main chat and
rings its phones. The main chat is looked up at each run, so tasks follow a new
one. Tasks of agents without a main chat, tasks of messaging channels, and
tasks of the apps' hidden data chats (`feed-…`, `ideas-…`, whose replies are
JSON for the app) reply in the chat that created them.

`--alert <kind>` (before the schedule) rings the creating operator's phones
when a run's reply lists items: a JSON array of objects with a `title`, read
from its first `[` to its last `]`. The alert shows the assistant's name and
the first title (`… (+2 more)`) and carries `kind`, `sessionId`, `messageId`
and `count`; a phone gets it only if it registered that kind with `/push`
(see [Web chat notifications](../guides/web-notifications.md#phones)). A reply
that lists nothing sends no alert, and such a task's replies never ring as
reminders. The item's title shows on the lock screen.

`--reply-only` (before the schedule) keeps each run's prompt and work out of
the chat: the run works in a session of its own, and only its reply is posted
to the chat, as a message from the agent with the source `schedule:<id>`. A
run that has nothing to say answers with the silent reply token and posts
nothing. Use it for a background check that should write into a conversation
the user also talks in, such as an app's main chat. With `--alert <kind>` as
well, a posted reply rings like a reminder of that kind, with the reply as the
body, and `results` lists the replies the task posted.

Every subcommand takes `--json` for clients that drive the command, such as an
app sending it through chat: the answer is one line of JSON (`{"version": 1,
"task": …}`, `{"version": 1, "tasks": […], "hidden": n}`, or `{"version": 1,
"task": …, "results": [{"id", "created_at", "text"}]}`). Line breaks,
carriage returns and backslashes inside strings are written as `\u000a`,
`\u000d` and `\u005c`, so a relay that turns the two characters `\n` into a
line break does not corrupt it.

`/device-data set <payload>`, `/device-data show` and `/device-data clear` are
how a companion app keeps what the user's phone shares on the gateway; see
[Device Data](../guides/device-data.md). They are not listed in menus or help.

### Todos

```text
/todo list
/todo add [--repeat daily|weekdays|mon,wed,fri] [--due YYYY-MM-DD] [--remind HH:MM] [--tz <zone>] <title>
/todo edit <id> [--repeat none] [--remind off] [same options] [<title>]
/todo done <id> [--date YYYY-MM-DD]
/todo undo <id> [--date YYYY-MM-DD]
/todo remove <id>
```

Todos are what the user means to do; `schedule` and the `cron` tool are what
the agent does at a time. A todo with `--repeat` opens again every day it
repeats on, in its time zone (`--tz`, else the one in `USER.md`, else the
host's), and counts a streak of those days done in a row. Nothing resets
it: each check-off is stored as a local date, and a repeating todo can be
checked off for any of the past six days. A one-off todo is listed until the
day after it was done. Options come before the title.

`--remind HH:MM` adds a scheduled task in the chat that set it, which fires
while the todo is still open. The scheduler skips it once the todo is done for
the day, so a reminder costs a model turn only when there is something to
say. In that turn the agent checks the list again, checks the todo off without
a message when it sees that the user did it, and otherwise writes a short
reminder that rings the phone like any other. Editing a todo replaces its
reminder, and removing the todo deletes it.

All web chats of an agent share one list; any other chat keeps its own. The
agent reads and changes the list with the `todo` tool, and every turn's
context lists the todos still open today, so "I just did my Chinese" is enough
for it to check one off. A check-off through `/todo` counts as the user's and
one through the tool as the agent's. With `--json` every subcommand answers
one line of JSON in the same escaping as `schedule`: `{"version": 1, "todos":
[…]}`, `{"version": 1, "todo": …}` or `{"version": 1, "removed": id}`. A todo
has `id`, `title`, `repeat` (day names or `null`), `due`, `remind`, `tz`,
`today`, `due_today`, `done`, `done_by` (`user` or `agent`), `streak`, and
`recent` (the dates it was done in the last two weeks).

### Goals and tracking

```text
/track list
/track add [--kind goal|tracking] [--every daily|weekdays|mon,thu] [--at HH:MM] [--tz <zone>] <title>
/track edit <id> [--every none] [same options] [<title>]
/track outcome <id> [<text>]
/track status <id> <text>
/track step <id> add <title>
/track step <id> done|undo|remove <step>
/track done|undo|remove <id>
```

Goals are what the user wants to reach (`--kind goal`, the default); tracked
items are what the agent keeps an eye on for them (`--kind tracking`). Each
has an optional outcome (what success looks like), steps, and a one-line
status. The newest status is the one apps show; the last twenty are kept as
the item's history. Not `/goal`, which keeps one chat working until a
condition holds.

`--every` adds a check-in: a scheduled task in the chat that set it, at
`--at` (default 09:00) in the item's time zone (`--tz`, else the one in
`USER.md`, else the host's). In that turn the agent looks into the item and
updates its status. A goal's check-in then writes to the user: where it
stands, the next open step, and a question. A tracked item's check-in writes
only when there is news or a decision for them. Editing the item moves its
check-in, marking it done or removing it deletes it, and a status line leaves
it alone.

Lists are shared like todos. The agent reads and changes them with the
`track` tool, and every turn's context lists the open items with their
status, so it can keep them current. A change through `/track` counts as the
user's and one through the tool as the agent's. Done items are dropped after
90 days. With `--json` every subcommand answers one line of JSON:
`{"version": 1, "items": […]}`, `{"version": 1, "item": …}` or
`{"version": 1, "removed": id}`. An item has `id`, `kind`, `title`,
`outcome`, `status`, `status_by`, `status_at`, `notes` (`at`, `by`, `text`),
`steps` (`id`, `title`, `done`), `every` (day names or `null`), `at`, `tz`,
`done`, `done_by`, `done_at`, `created_at` and `created_by`.

### Name

```text
/name
/name set <name>
/name clear
```

What the agent calls the user. It is kept as "What to call them" in the
agent's `USER.md`, which is in every turn's prompt, so the next turn uses it.
`/name` shows that field, or the `USER.md` "Name" when it is empty; `clear`
empties the field, so the agent goes by "Name" again. A name is one line of
at most 80 characters. Companion apps set it from their settings with
`--json`, which answers `{"version": 1, "name": …, "full_name": …}` in the
same escaping as `schedule`: "What to call them" and "Name", each `null` when
not filled in.

### Time zone

```text
/timezone
/timezone set <zone>
/timezone clear
```

The user's time zone, kept as "Timezone" in the agent's `USER.md`. Schedules
the agent creates without a zone of their own, the daily memory note and the
prompt's current time use it; while it is empty or not a valid zone they use
the host's zone. `set`
takes an IANA name such as `Europe/Berlin` and writes it in its canonical
spelling, replacing the whole line. Companion apps send the phone's zone with
`--json`, which answers `{"version": 1, "timezone": …}` in the same escaping as
`schedule`, `null` when there is no valid zone. Scheduled tasks that already
exist keep the zone they were created with.

### Import

```text
/import <chatgpt|claude|openclaw|hermes|files>
/import review <id>
```

Brings what the user told another assistant into the agent's memory, in two
steps. Sent with uploaded files (the `media` of an `/api/chat` turn),
`/import <source>` stages them in the agent's workspace under
`imports/<id>/`: a ChatGPT or Claude export (`.zip` or `conversations.json`)
becomes `conversations.md`, the user's own messages with the newest
conversations first, about 120,000 characters at most, plus ChatGPT's custom
instructions and Claude's project descriptions; Markdown and text files, such
as an answer pasted from the other assistant or OpenClaw and Hermes
`MEMORY.md`, `USER.md` and `memory/` notes, are kept as they are. Settings,
keys and skills in an agent home stay out. `files` keeps documents (PDF,
Office, text, Markdown, CSV, JSON). Nothing is written to `USER.md` or
`MEMORY.md` at this step.

`/import review <id>` then becomes one ordinary agent turn: the stored user
message is a plain sentence such as "Import what ChatGPT knows about me.", and
the turn's operator instructions tell the agent to read the staged files, fold
what matters into `USER.md` and `MEMORY.md`, leave out secrets, and answer with
what it now knows. Over `/api/chat` only; elsewhere it just names the import.

Companion apps stage with `--json`, which answers
`{"version": 1, "id": …, "source": …, "files": […], "conversations": …, "omitted": …}`
in the same escaping as `schedule`, or `{"version": 1, "error": …}` with
`unknown-source`, `no-files`, `unreadable`, `nothing-found` or
`unknown-import`.

### Receipts

```text
/receipts [--limit <n>]
```

What the agent did outside its sandbox for you: mails it sent, events it
made, orders it placed and other red-tier actions, and who let each through
(you for this one, an earlier yes for the session, agent or everything, full
autonomy, or the policy without asking). It reads the structured audit, so
runs of scheduled tasks are included. A chat sees its own receipts; a web chat
also those of the agent's other web chats and of the scheduled tasks it may
manage. Actions still waiting for an answer, denied or blocked are not
receipts. Companion apps list them with `--json`, which answers
`{"version": 1, "receipts": […]}` in the same escaping as `schedule`: each
with `id`, `at`, `session`, `task`, `tool`, `service`, `action`, `to`,
`subject`, `title`, `when`, `url`, `allowed` (`you`, `earlier`, `full` or
`policy`), `ok` and `error`. `to` holds the recipients' domains ("@aa.com"),
which the audit keeps next to arguments whose addresses it redacts. Never a
mail's body.

`/agent`, `/model`, `/reset`, `/mcp`, `/btw`, `/aux`, `/second-opinion`, and
related slash commands route through the same gateway command surface used by
TUI and web chat. `/context` is local-only because it exposes session
context-window accounting.

### Agent-created schedules

When an agent uses the `cron` tool, recurring expressions use the timezone
recorded in the workspace's `USER.md`, or an explicit IANA `tz` value such as
`Europe/Berlin`. If neither is available, the fallback is UTC. Write five-field
expressions in that local time; `0 9 * * *` means 09:00 in the stored timezone.
This timezone selection applies to the agent tool, not the separate
`!claw schedule add` command above. The zone is the first word of the
`**Timezone:**` line in `USER.md`, so a note after it does no harm; when that
word is not an IANA zone, every turn's context says so, so the agent can
correct it.

The tool returns a real task ID after the gateway persists the schedule.
Web-chat and heartbeat tasks require an explicit delivery channel. The task
list and **Automation → Scheduler** show the stored timezone and the reason
for a failed run or delivery. In web chat, the agent can list, update, and
remove tasks created in another web chat assigned to the same agent. Tasks
created in messaging channels remain scoped to their original session; the
web-chat task list reports how many of them exist for the agent, so they can
be managed from **Automation → Scheduler** instead of being created again.
Invalid cron expressions are disabled with the parse error recorded; one-shot
tasks that never ran are retained. The list is read when the tool is called,
so it includes what the turn changed through `track` or `todo`. A goal's
check-in and a todo's reminder are listed as such, and the `cron` tool cannot
update or remove them: they move with their item, so they change through
`track` or `todo`.

Use the `cron` tool's `update` action with the existing `taskId` to change a
schedule, prompt, or delivery channel without creating a duplicate. Updating a
task from another web chat preserves its original execution session and delivery
target unless explicitly changed. If a scheduled agent returns the internal
`__MESSAGE_SEND_HANDLED__` sentinel, the scheduler skips its delivery callback
while retaining the run in history and audit records.

## In Session

- `/help` shows the same canonical slash-command list in TUI and embedded web
  chat, filtered per surface and kept in a consistent alphabetical order
- `/audit turn <n>` and `/audit run <runId>` show focused turn traces for one
  request, including nearby tool, approval, and audit events
- `/aux test <task> <prompt>` triggers a configured auxiliary text task on
  demand and prints the provider/model that answered
- `/second-opinion` compares a question or validates the last answer with a
  stronger configured model; `fact-check` adds bounded web-search evidence
- `/escalate` is registered by the bundled tier router when `routing.enabled`
  is true and raises exactly the next unpinned agent turn by one tier

### Slash Command Inventory

These are the built-in slash commands exposed by local sessions and, where
supported by the channel, by Discord/Slack slash or slash-text routing. Loaded
plugins and explicit skill invocations can add dynamic slash commands; use
`/help` or the TUI slash menu for the live session-specific list.

| Command | Main surface | Purpose |
|---|---|---|
| `/agent [info|list|switch|create|install|model]` | local and chat channels | Inspect, create, switch, install, or set models for agents; web `/agent switch` starts hatching when `BOOTSTRAP.md` is active |
| `/app <description>` or `/apps` | web chat | Start an app-building conversation or open the Apps gallery |
| `/approvals mode [ask|auto|full]` | local and chat channels | Show or set how often this session asks for approval |
| `/approve [view|yes|session|agent|all|no] [approval_id]` | local and chat channels | View or answer pending tool approval requests |
| `/audit [sessionId]|last|turn <n>|run <runId>` | local and chat channels | Show recent audit events or focused turn traces |
| `/auth status <provider>` | local TUI/web | Show local auth and provider config state |
| `/aux test <task> <prompt>` | local TUI/web | Trigger a configured auxiliary text task and show the provider/model used |
| `/bot [info|list|set <id|name>|clear]` | local and chat channels | Inspect or select the active chatbot |
| `/btw <question>` | local and chat channels | Ask an ephemeral side question without tools or persistence |
| `/channel-mode <off|mention|free>` | chat channels | Set the current channel response mode |
| `/channel-policy <open|allowlist|disabled>` | chat channels | Set the guild/workspace channel policy |
| `/clear` | local and chat channels | Clear the visible session transcript |
| `/compact` | local and chat channels | Compact older session history into memory |
| `/concierge [info]` | local and chat channels | Inspect routing; configure it in Models → Routing |
| `/config [check|reload|get|set]` | local TUI/web | Inspect, reload, or edit runtime config |
| `/context` | local TUI/web | Show context-window usage and compaction headroom |
| `/dream [status|on|off|now]` | local TUI/web | Configure or run memory consolidation |
| `/env [list|set|show|unset]` | local TUI/web | Manage plaintext runtime env values for agents and helpers |
| `/escalate` | local and chat channels | Start the next unpinned agent turn one configured routing tier higher |
| `/export session [sessionId]` | local and chat channels | Export a session snapshot |
| `/export trace [sessionId|all]` | local and chat channels | Export trace JSONL |
| `/fullauto [status|off|on [prompt]|prompt]` | local and chat channels | Inspect or control full-auto mode for the session |
| `/goal [condition|status|pause|resume|clear]` | local and chat channels | Set a completion condition and keep working until judged complete or paused |
| `/help` or `/h` | local and chat channels | Show slash-command help |
| `/info` | TUI | Show bot, model, and runtime status together |
| `/name [set <name>|clear]` | local TUI/web | Show or change what the agent calls you |
| `/timezone [set <zone>|clear]` | local TUI/web | Show or change your time zone for schedules and dates |
| `/import <source>`, `/import review <id>` | local TUI/web | Read what you told ChatGPT, Claude, OpenClaw or Hermes, or files about you, into memory |
| `/mcp [list|add|toggle|remove|reconnect|login|logout|status]` | local and chat channels | Manage runtime MCP servers and OAuth login state |
| `/memory inspect [sessionId]` | local TUI/web | Inspect built-in memory layers |
| `/memory query <query>` | local TUI/web | Preview prompt-time memory attachment |
| `/model [info|list|set|clear|default|select]` | local and chat channels | Inspect or set session/default models |
| `/new` | local and chat channels | Start a fresh session for the current chat; the previous session stays switchable via `/sessions` |
| `/paste` | TUI | Attach a copied local file or clipboard image |
| `/policy [status|list|allow|deny|delete|preset|default|reset]` | local TUI/web | Inspect or update workspace network policy |
| `/plugin [list|enable|disable|config|install|reinstall|reload|uninstall]` | local TUI/web | Manage runtime plugins |
| `/rag [on|off]` | local and chat channels | Toggle prompt-time retrieval augmentation |
| `/ralph [info|on|off|set n]` | local and chat channels | Configure the Ralph loop |
| `/reset [yes|no]` | local and chat channels | Run the confirmed workspace reset flow |
| `/schedule add|list|results|update|remove|toggle ...` | local and chat channels | Manage scheduled tasks for the chat and read what their runs answered |
| `/secret [list|set|status|unset|route]` | local TUI/web | Manage encrypted secrets and HTTP auth routes |
| `/second-opinion [compare|validate|fact-check]` | local and chat channels | Ask a stronger configured model to compare, validate, or fact-check |
| `/sessions [list|switch <number|session-id>|active|clear-active|prune --older-than <duration> [--dry-run|--confirm]]` | local and chat channels | List or switch sessions for the current chat, inspect active session tracking, or prune old persisted sessions |
| `/show [all|thinking|tools|none]` | local and chat channels | Control thinking/ordinary-tool visibility; memory access stays visible |
| `/skill ...` or `/<skill>` | local TUI/web | Manage skills or explicitly invoke one skill |
| `/status` | local and chat channels | Show runtime, session, and agent status |
| `/thumbs up|down [comment]` or `/thumbs clear` | local and chat channels | Rate the last answer, optionally adding a correction or the expected answer |
| `/stop` or `/abort` | TUI and active local runs | Stop the current foreground request and full-auto mode; delegations the stopped request queued are not started |
| `/usage [summary|daily|monthly|model ...]` | local and chat channels | Show token/cost usage summaries |
| `/voice [info|call <e164-number>]` | local TUI/web | Inspect voice setup or place a Twilio outbound call |
| `/exit`, `/quit`, or `/q` | TUI | Exit the TUI |

Task editors use `/schedule list --json` to read the `editor` capabilities,
available models, supported reasoning efforts, and each task’s `revision`.
To edit a task, send `/schedule update --json <id> <payload>` with a single
base64url-encoded UTF-8 JSON payload. The payload includes the current `revision`,
`title`, `prompt`, `cron`, `tz`, `run_at`, `every_ms`, `model`, `effort`,
`fresh_session`, and `enabled`. Exactly one of `cron`, `run_at`, and `every_ms`
is non-null. Send explicit nulls to clear optional model or effort overrides.
A stale revision or invalid field rejects the entire update.

Edits retain the task ID, ownership, original chat, delivery channel, alert,
and reply-only behavior. `fresh_session: true` starts an isolated runtime
session for each run and delivers replies to the original chat. It does not
create a new visible chat. Leaving `model` null inherits the original chat’s
model when the task runs; overrides affect only that scheduled run.


### Standing Goals

`/goal <condition>` and `/goal set <condition>` store one active completion
condition for the current thread and queue it as the first supervised user-role
turn. A useful shape is:

```text
/goal [do the work] until [measurable end state] without [constraints]
```

Strong conditions have three parts: the task in one clear line, a measurable
done state, and any constraints the agent must follow. Examples:

```text
/goal research recent changes in EU AI Act enforcement until you have a cited brief without using non-primary sources
/goal improve README until a new contributor can install, run, and test the project without asking follow-up questions
/goal add a dark/light theme toggle until it persists in localStorage and is verified in browser without changing unrelated UI
```

Later continuations are also normal user-role turns tagged internally as
`goal-continuation`; they do not change the system prompt, tool set, or
approval policy. Only one standing goal is active per thread.

Use `/goal` or `/goal status` to inspect progress, `/goal pause` to stop
queueing continuations, `/goal resume` to continue, and `/goal clear` to remove
the stored goal. `stop`, `off`, `reset`, `none`, and `cancel` are aliases for
`clear`. Status shows the condition, elapsed time, evaluated turns, token/cost
spend since the goal was set, and the judge's most recent reason. If the goal
has already been achieved, `/goal` keeps showing the achieved condition and its
final counters until you set or clear another goal. The default budget is 20
continuation turns. After each continuation, a cheap judge checks the condition
against the recent conversation context and returns strict JSON
`{ "done": boolean, "reason": string }`; if the answer is no, the reason is
included as guidance for the next turn. The loop pauses after three malformed
judge responses.

High-stakes tool calls inside goal continuations still escalate through the
same approval flow as ordinary turns. Pending approvals pause the goal without
counting another turn, and any real user message preempts the loop so the
operator stays in control. `/goal` persists intent; it does not bypass
approval policy or grant full-auto permissions.

When an agent reaches its monthly budget cap (`agents.list[].budget`), the
gateway refuses further turns for it and pauses its active goal with the reason
`agent budget hard-stop`.

- local TUI/web sessions also support `/memory inspect [sessionId]` to inspect
  the built-in memory layers for the current or an explicit session id
- local TUI/web sessions support `/btw <question>` for ephemeral side
  questions that use recent conversation context, return a tool-less answer,
  and do not persist the side exchange to session history
- in built-in web chat, `/btw` is the only slash command accepted while the
  current run is active
- local TUI/web sessions support `/memory query <query>` to preview the exact
  prompt-memory block the current session would attach for that query
- web chat supports `/app <description>` to start an app-building conversation;
  bare `/app` and `/apps` open the Apps gallery
- local TUI/web sessions support `/context` to inspect context-window usage,
  remaining headroom, and compaction count for the active session
- local TUI and web chat expose `/voice info` and `/voice call <e164-number>`
  for local Twilio diagnostics and outbound dialing
- Local TUI and web chat sessions expose `/config`, `/config check`,
  `/config reload`, `/config get <key>`, `/config set <key> <value>`,
  `/concierge`, `/auth status <provider>`, and
  `/secret list|set|status|unset|route`
  alongside the existing runtime commands
- local TUI and web chat also expose `/dream [info|on|off|now]` for nightly
  memory-consolidation status, scheduler toggling, and manual runs
- TUI and chat surfaces use `/agent`, `/agent install`, `/model`, `/mcp`,
  `/plugin`, `/skill`, `/compact`, `/reset`, `/plugin enable`,
  `/plugin disable`, `/plugin install`, `/plugin reinstall`, `/plugin reload`,
  `/skill install`, `/skill import`, `/skill learn`, `/schedule`, `/status`,
  and related slash commands
- TUI also supports `/paste` to queue a copied local file or clipboard image
- TUI `/skill config` opens the interactive skill availability checklist
- local TUI and web chat support `/skill list` to inspect dependency ids.
- local TUI and web chat support `/skill install <source>`, `/skill upgrade <source>`, `/skill uninstall <skill>`, `/skill revisions <skill>`, and `/skill rollback <skill> <revision-id>` for package lifecycle work.
- local TUI and web chat support `/skill install <skill> <dependency>` to run one declared skill dependency, and `/skill setup <skill>` to run every declared dependency for a skill.
- an explicit `/<skill>` or `/skill <name>` turn keeps that skill active for
  the next plain-text follow-up in the same session; a new slash command
  cancels that carry-over
- `/status` shows both the current session and current agent
- `/compact` runs session compaction, and `/reset` runs the confirmed
  workspace reset flow
- `/plugin ...` manages runtime plugins, and `/mcp ...` manages runtime MCP
  servers
- `/auth status <provider>` shows local auth and config state for every
  `hybridclaw auth` target except `anthropic`, `google`, `hubspot`, and
  `microsoft365`; run `hybridclaw auth status <provider>` for those four
- Typing `/` in the TUI opens the slash-command menu with inline filtering and
  help aliases
- The TUI startup banner summarizes the active model, sandbox, gateway,
  provider, and chatbot context before the first prompt
- Pending approvals in the TUI open an interactive picker with `Up` / `Down`
  navigation, `Enter` confirmation, number-key quick select, and `Esc` to
  skip; non-interactive terminals keep the text prompt fallback
- pressing `Up` or `Down` on an empty prompt recalls earlier prompts
- press `Ctrl-C` or `Ctrl-D` twice within five seconds to exit the TUI
- on exit, HybridClaw prints token/file/tool totals when remote history is
  available, otherwise an explicit unavailable summary, plus a ready-to-run
  `hybridclaw tui --resume <sessionId>` command for that session

Example secret flow:

```text
/secret set STAGING_HYBRIDAI_API_KEY demo_key_2024
/secret route add https://staging.hybridai.one/api/v1/ STAGING_HYBRIDAI_API_KEY X-API-Key none
```

With that route in place, the model can use `http_request` to call matching
URLs without seeing the plaintext API key.

Example skill dependency flow:

```text
/skill list
/skill setup gws
/skill install manim-video manim
/skill install manim-video ffmpeg
```
