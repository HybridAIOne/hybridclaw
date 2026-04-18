---
title: Commands
description: High-value CLI, gateway, agent, skill, plugin, and audit commands.
sidebar_position: 5
---

# Commands

## Core Runtime

```bash
hybridclaw --version
hybridclaw gateway start [--foreground] [--debug] [--log-requests] [--sandbox=container|host]
hybridclaw gateway restart [--foreground] [--debug] [--log-requests] [--sandbox=container|host]
hybridclaw gateway stop
hybridclaw gateway status
hybridclaw gateway voice info
hybridclaw gateway voice call <number>
hybridclaw gateway <command...>
hybridclaw gateway compact
hybridclaw gateway memory inspect [sessionId]
hybridclaw gateway reset [yes|no]
hybridclaw eval [list|env|<suite>] [--current-agent|--fresh-agent] [--ablate-system] [--include-prompt=<parts>] [--omit-prompt=<parts>]
hybridclaw eval locomo [setup|run|status|stop|results|logs]
hybridclaw eval terminal-bench-2.0 [setup|run|status|stop|results|logs]
hybridclaw eval tau2 [setup|run|status|stop|results]
hybridclaw eval hybridai-skills [setup|list|run|results]
hybridclaw eval [--current-agent|--fresh-agent] [--ablate-system] [--include-prompt=<parts>] [--omit-prompt=<parts>] <command...>
hybridclaw tui
hybridclaw tui --resume <sessionId>
hybridclaw --resume <sessionId>
hybridclaw onboarding
hybridclaw doctor [--fix|--json|<component>]
hybridclaw config
hybridclaw config check
hybridclaw config reload
hybridclaw config set <key> <value>
hybridclaw config revisions [list|rollback <id>|delete <id>|clear]
hybridclaw browser login [--url <url>]
hybridclaw browser status
hybridclaw browser reset
hybridclaw gateway concierge [info|on|off|model [name]|profile <asap|balanced|no_hurry> [model]]
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

## Local Eval Workflows

`hybridclaw eval` and local `/eval` commands point benchmark harnesses at
HybridClaw's loopback OpenAI-compatible API.

```bash
hybridclaw eval list
hybridclaw eval env
hybridclaw eval locomo setup
hybridclaw eval locomo run --budget 4000 --max-questions 20
hybridclaw eval locomo run --mode retrieval --budget 4000 --max-questions 20
hybridclaw eval locomo run --mode retrieval --retrieval-query raw --budget 4000 --max-questions 20
hybridclaw eval locomo run --mode retrieval --retrieval-backend full-text --budget 4000 --max-questions 20
hybridclaw eval locomo run --mode retrieval --retrieval-backend hybrid --budget 4000 --max-questions 20
hybridclaw eval locomo run --mode retrieval --retrieval-rerank bm25 --budget 4000 --max-questions 20
hybridclaw eval locomo run --mode retrieval --retrieval-tokenizer porter --budget 4000 --max-questions 20
hybridclaw eval locomo run --mode retrieval --retrieval-tokenizer trigram --budget 4000 --max-questions 20
hybridclaw eval locomo run --mode retrieval --retrieval-embedding transformers --budget 4000 --max-questions 20
hybridclaw eval locomo run --mode retrieval --matrix --budget 4000
hybridclaw eval locomo run --mode retrieval --matrix backend --budget 4000
hybridclaw eval locomo run --mode retrieval --matrix rerank --budget 4000
hybridclaw eval locomo run --mode retrieval --matrix tokenizer --budget 4000
hybridclaw eval locomo run --mode retrieval --matrix embedding --budget 4000
hybridclaw eval tau2 setup
hybridclaw eval tau2 run --domain telecom --num-trials 1 --num-tasks 10
hybridclaw eval terminal-bench-2.0 setup
hybridclaw eval terminal-bench-2.0 run --num-tasks 10
hybridclaw eval hybridai-skills setup
hybridclaw eval hybridai-skills list --skill code-review
hybridclaw eval hybridai-skills run --dry-run
hybridclaw eval hybridai-skills run --max 3
hybridclaw eval hybridai-skills run --live --skill apple-music --max 1
hybridclaw eval --fresh-agent --omit-prompt=bootstrap inspect eval inspect_evals/gaia --model "$HYBRIDCLAW_EVAL_MODEL" --log-dir ./logs
```

- local-only surface from CLI, TUI, or embedded web chat; it is not intended
  for Discord, Teams, WhatsApp, email, or other remote chat channels
- managed suites today: `locomo`, `tau2`, `terminal-bench-2.0`, and
  `hybridai-skills`
- `hybridai-skills` harvests the 🎯 *Try it yourself* prompts from
  `docs/development/guides/skills/*.md` into a fixture set, then grades
  whether each prompt activates its documented skill. `setup` writes the
  fixture JSONL, `list` inspects it, `run --dry-run` validates fixtures
  without calling the model, and `run` (default `--live`, `--max 3`) posts
  each prompt to the local OpenAI endpoint and grades the tool trace with
  the same `resolveObservedSkillName` oracle the gateway uses
- filter `hybridai-skills` runs with `--skill <name>`, `--kind
  try-it|conversation`, and `--max N`; results
  land at `~/.hybridclaw/data/evals/hybridai-skills/latest-run.json` and
  are also shown via `/eval hybridai-skills results`
- for `hybridai-skills run`, `--explicit` rewrites each prompt to start with
  `/<skill>` to force invocation
- `locomo --mode qa` runs a native HybridClaw QA harness against the official
  LoCoMo conversations, generates answers through the local OpenAI-compatible
  gateway, and scores those answers with LoCoMo-style question metrics
- `locomo --mode retrieval` skips model generation, ingests each conversation
  into an isolated native memory session, and scores evidence hit-rate from
  recalled semantic memories
- `locomo --mode retrieval --matrix` runs the default retrieval sweep across
  backend, rerank, and tokenizer combinations and renders one comparison table
- `locomo --mode retrieval --matrix backend|rerank|tokenizer|embedding` runs a
  single-dimension sweep and keeps the other retrieval settings at their
  defaults
- retrieval-mode knobs are benchmark-only: `--retrieval-query
  raw|no-stopwords`, `--retrieval-backend cosine|full-text|hybrid`,
  `--retrieval-rerank none|bm25` (default: `bm25`),
  `--retrieval-tokenizer unicode61|porter|trigram`, and
  `--retrieval-embedding hashed|transformers`
- `locomo --num-samples` limits conversation records; use `--max-questions`
  for quick smoke tests over a small question slice
- by default, `locomo --mode qa` creates one fresh template-seeded agent
  workspace per conversation sample; use `--current-agent` to reuse the current
  agent workspace
- `swebench-verified`, `agentbench`, and `gaia` currently print starter
  recipes and setup guidance rather than a native managed runner
- outside suite-specific overrides, the default eval mode keeps the current
  agent workspace but opens a fresh OpenAI-compatible session per request
- `--fresh-agent` uses a temporary template-seeded agent workspace for each
  eval request
- detached run logs and summaries are stored under
  `~/.hybridclaw/data/evals/`

The same loopback surface is available directly from the running gateway:

```bash
curl http://127.0.0.1:9090/v1/models

curl http://127.0.0.1:9090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <WEB_API_TOKEN>' \
  -d '{"model":"hybridai/gpt-4.1-mini","messages":[{"role":"user","content":"Hello"}]}'
```

- `/v1/models` and `/v1/chat/completions` use the same local gateway process;
  they are not a separate service
- if `WEB_API_TOKEN` is unset, loopback requests from the same host can omit
  the `Authorization` header; otherwise send `Bearer <WEB_API_TOKEN>`
- these endpoints are intended for local tooling and eval harnesses rather than
  public exposure

## Auth And Providers

```bash
hybridclaw auth login [provider] ...
hybridclaw auth status <provider>
hybridclaw auth logout <provider>
hybridclaw auth whatsapp reset
hybridclaw auth login msteams [--app-id <id>] [--app-password <secret>] [--tenant-id <id>]
hybridclaw auth login slack [--bot-token <xoxb...>] [--app-token <xapp...>]
hybridclaw local status
hybridclaw local configure <backend> [model-id] [--base-url <url>] [--api-key <key>] [--no-default]
hybridclaw help auth
hybridclaw help openrouter
hybridclaw help mistral
hybridclaw help huggingface
hybridclaw help gemini
hybridclaw help deepseek
hybridclaw help xai
hybridclaw help zai
hybridclaw help kimi
hybridclaw help minimax
hybridclaw help dashscope
hybridclaw help xiaomi
hybridclaw help kilo
```

`auth status` supports `hybridai`, `codex`, `openrouter`, `mistral`,
`huggingface`, `gemini`, `deepseek`, `xai`, `zai`, `kimi`, `minimax`,
`dashscope`, `xiaomi`, `kilo`, `local`, `msteams`, and `slack`.
Legacy aliases such as `hybridclaw hybridai ...`, `hybridclaw codex ...`, and
`hybridclaw local ...` still work, but `auth` is the primary surface.

## Channel Setup

```bash
hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]
hybridclaw channels telegram setup [--token <token>] [--allow-from <user-id|@username|*>]... [--group-allow-from <user-id|@username|*>]... [--dm-policy <open|allowlist|disabled>] [--group-policy <open|allowlist|disabled>] [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>] [--require-mention|--no-require-mention]
hybridclaw channels imessage setup [--backend <local|remote>] [--allow-from <phone|email|chat:id>]... [--server-url <url>] [--password <password>] [--cli-path <path>] [--db-path <path>] [--webhook-path <path>] [--allow-private-network]
hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...
hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--imap-port <port>] [--imap-secure|--no-imap-secure] [--smtp-host <host>] [--smtp-port <port>] [--smtp-secure|--no-smtp-secure] [--folder <name>]... [--allow-from <email|*@domain|*>]... [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>]
hybridclaw gateway voice info
hybridclaw gateway voice call <number>
hybridclaw auth login msteams [--app-id <id>] [--app-password <secret>] [--tenant-id <id>]
hybridclaw auth login slack [--bot-token <xoxb...>] [--app-token <xapp...>]
```

Microsoft Teams and Slack setup use `auth login` instead of `channels setup`
because they need app credentials rather than a local pairing flow. For the
step-by-step setup guide, see
[Getting Started: Channel Setup](../getting-started/channels.md).
Twilio voice is configured through `/admin/channels` or direct `voice.*`
config keys, then inspected or used for outbound dialing with
`hybridclaw gateway voice info` and `hybridclaw gateway voice call <number>`.
Local TUI/web sessions can also write channel config and secrets with
`/config set ...` and `/secret set ...`; see the same guide for channel-specific
examples and current CLI-only limitations such as WhatsApp pairing.

## Agents And Packages

```bash
hybridclaw agent list
hybridclaw agent export [agent-id] [-o <path>]
hybridclaw agent inspect <file.claw>
hybridclaw agent install <file.claw|https://.../*.claw|official:<agent-dir>|github:owner/repo[/<ref>]/<agent-dir>> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--skip-import-errors] [--yes]
hybridclaw agent uninstall <agent-id> [--yes]
hybridclaw gateway agent [list|switch <id>|create <id>|model [name]]
```

`agent export` and `agent install` are the primary archive verbs. Legacy
aliases remain accepted: `agent pack` maps to `export`, and `agent unpack`
maps to `install`. Local TUI/web sessions also expose `/agent install <source>`
for the same archive flows against a running gateway.
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

## Skills, Tools, Plugins, Audit

```bash
hybridclaw skill list
hybridclaw skill enable <skill-name> [--channel <kind>]
hybridclaw skill disable <skill-name> [--channel <kind>]
hybridclaw skill toggle [--channel <kind>]
hybridclaw skill inspect <skill-name>
hybridclaw skill inspect --all
hybridclaw skill runs <skill-name>
hybridclaw skill install <skill-name> <dependency>
hybridclaw skill learn <skill-name> [--apply|--reject|--rollback]
hybridclaw skill history <skill-name>
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
hybridclaw plugin uninstall <plugin-id>
hybridclaw update [status|--check] [--yes]
hybridclaw audit recent
hybridclaw audit approvals [n] [--denied]
hybridclaw audit search <query>
hybridclaw audit verify [sessionId]
hybridclaw audit instructions [--sync]
```

`skill import [--force] [--skip-skill-scan]` supports packaged `official/<skill-name>` sources plus
community imports from `skills-sh`, `clawhub`, `lobehub`,
`claude-marketplace`, `well-known`, and explicit GitHub repo/path refs.
`skill install <skill-name> <dependency>` runs one declared dependency from the
named skill. Use `skill list` first to discover the dependency ids exposed by a
skill.
`update` checks for a newer installed release and can upgrade a global npm
install. When `--yes` completes successfully and a local gateway is already
running with a replayable launch command, HybridClaw restarts it automatically
with the original parameters; otherwise it falls back to manual restart
instructions. Source checkouts receive git-based update instructions instead.

## Discord And Session Commands

Discord supports `!claw` plus slash-command equivalents for the same core
actions. Common examples:

```text
!claw <message>
/agent
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
!claw schedule add at "<ISO time>" <prompt>
!claw schedule add every <ms> <prompt>
```

`/agent`, `/model`, `/reset`, `/mcp`, and related slash commands route through
the same gateway command surface used by TUI and web chat.

## In Session

- `/help` shows the same canonical slash-command list in TUI and embedded web
  chat, filtered per surface and kept in a consistent alphabetical order
- local TUI/web sessions also support `/memory inspect [sessionId]` to inspect
  the built-in memory layers for the current or an explicit session id
- local TUI/web sessions support `/memory query <query>` to preview the exact
  prompt-memory block the current session would attach for that query
- local TUI and web chat expose `/voice info` and `/voice call <e164-number>`
  for local Twilio diagnostics and outbound dialing
- Local TUI and web chat sessions expose `/config`, `/config check`,
  `/config reload`, `/config set <key> <value>`, `/config revisions`,
  `/concierge`, `/auth status hybridai`, and `/secret list|set|unset|show|route`
  alongside the existing runtime commands
- local TUI and web chat also expose `/dream [info|on|off|now]` for nightly
  memory-consolidation status, scheduler toggling, and manual runs
- local TUI and web chat expose `/eval ...`, mirroring the CLI eval helper and
  surfacing progress for managed runs such as `tau2` and
  `terminal-bench-2.0`
- TUI and chat surfaces use `/agent`, `/agent install`, `/model`, `/mcp`,
  `/plugin`, `/skill`, `/compact`, `/reset`, `/plugin enable`,
  `/plugin disable`, `/plugin install`, `/plugin reinstall`, `/plugin reload`,
  `/skill install`, `/skill import`, `/skill learn`, `/schedule`, `/status`,
  and related slash commands
- TUI also supports `/paste` to queue a copied local file or clipboard image
- TUI `/skill config` opens the interactive skill availability checklist
- local TUI and web chat support `/skill list` to inspect dependency ids and
  `/skill install <skill> <dependency>` to run one declared skill dependency
- an explicit `/<skill>` or `/skill <name>` turn keeps that skill active for
  the next plain-text follow-up in the same session; a new slash command
  cancels that carry-over
- `/status` shows both the current session and current agent
- `/compact` runs session compaction, and `/reset` runs the confirmed
  workspace reset flow
- `/plugin ...` manages runtime plugins, and `/mcp ...` manages runtime MCP
  servers
- `/auth status hybridai` shows local HybridAI auth and config state
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
/skill install manim-video uv-manim
/skill install manim-video brew-ffmpeg
```
