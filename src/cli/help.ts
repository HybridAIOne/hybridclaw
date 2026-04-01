import { runtimeConfigPath } from '../config/runtime-config.js';
import { runtimeSecretsPath } from '../security/runtime-secrets.js';

export function printMainUsage(): void {
  console.log(`Usage: hybridclaw <command>

  Commands:
  agent      Export, inspect, install, or uninstall portable agent archives
  auth       Unified provider login/logout/status
  config     Show or edit the local runtime config
  gateway    Manage core runtime (start/stop/status) or run gateway commands
  tui        Start terminal adapter (starts gateway automatically when needed)
  onboarding Run interactive auth + trust-model onboarding
  channels   Channel setup helpers (Discord, WhatsApp, Email)
  browser    Manage persistent browser profiles for agent web automation
  migrate    Import state from another agent home
  plugin     Manage HybridClaw plugins
  skill      List skill dependency installers or run one
  tool       List or disable built-in agent tools
  update     Check and apply HybridClaw CLI updates
  audit      Inspect/verify structured audit trail
  doctor     Run environment and runtime diagnostics
  help       Show general or topic-specific help (e.g. \`hybridclaw help gateway\`)

  Options:
  --resume <id>  Resume a saved TUI session
  --version, -v  Show HybridClaw CLI version`);
}

export function printGatewayUsage(): void {
  console.log(`Usage: hybridclaw gateway <subcommand>

Commands:
  hybridclaw gateway
  hybridclaw gateway start [--foreground] [--debug] [--log-requests] [--sandbox=container|host]
  hybridclaw gateway restart [--foreground] [--debug] [--log-requests] [--sandbox=container|host]
  hybridclaw gateway stop
  hybridclaw gateway status
  hybridclaw gateway sessions
  hybridclaw gateway bot info
  hybridclaw gateway show [all|thinking|tools|none]
  hybridclaw gateway reset [yes|no]
  hybridclaw gateway <discord-style command ...>`);
}

export function printTuiUsage(): void {
  console.log(`Usage:
  hybridclaw tui [--resume <sessionId>]
  hybridclaw --resume <sessionId>

Starts the terminal adapter and connects to the running gateway.
If gateway is not running, it is started in backend mode automatically.
By default, \`hybridclaw tui\` starts a fresh local CLI session.

Interactive slash commands inside TUI:
  /agent [list|switch|create|model]
  /approve [view|yes|session|agent|no] [approval_id]
  /audit [sessionId]
  /auth status <provider>
  /bot [info|list|set <id|name>|clear]
  /channel-mode <off|mention|free>
  /channel-policy <open|allowlist|disabled>
  /clear
  /compact
  /concierge [info|on|off|model [name]|profile <asap|balanced|no_hurry> [model]]
  /config   /config check   /config reload   /config set <key> <value>   /config revisions
  /exit
  /export session [sessionId]   /export trace [sessionId|all]
  /fullauto [status|off|on [prompt]|prompt]
  /help
  /info
  /mcp list   /mcp add <name> <json>   /mcp toggle <name>   /mcp remove <name>   /mcp reconnect <name>
  /model [name]   /model info|list [provider]|set <name>|clear|default [name]
  /paste
  /plugin [list|enable|disable|config|install|reinstall|reload|uninstall]
  /rag [on|off]
  /ralph [info|on|off|set n]
  /reset [yes|no]
  /schedule add "<cron>" <prompt> | at "<ISO time>" <prompt> | every <ms> <prompt>
  /secret list   /secret set <name> <value>   /secret show <name>   /secret unset <name>   /secret route ...
  /sessions
  /show [all|thinking|tools|none]
  /skill config|list|inspect <name>|inspect --all|runs <name>|learn <name> [--apply|--reject|--rollback]|history <name>|sync [--skip-skill-scan] <source>|import [--force] [--skip-skill-scan] <source>
  /status
  /stop
  /usage [summary|daily|monthly|model [daily|monthly] [agentId]]`);
}

export function printOnboardingUsage(): void {
  console.log(`Usage: hybridclaw onboarding

Runs the HybridClaw onboarding flow:
  1) trust-model acceptance
  2) auth provider selection
  3) HybridAI API key setup, OpenAI Codex OAuth login, OpenRouter API key setup, Mistral API key setup, or Hugging Face token setup
  4) default model/bot persistence`);
}

export function printLocalUsage(): void {
  console.log(`Usage: hybridclaw local <command> (deprecated)

Commands:
  hybridclaw local status
  hybridclaw local configure <ollama|lmstudio|llamacpp|vllm> [model-id] [--base-url <url>] [--api-key <key>] [--no-default]

Use Instead:
  hybridclaw auth login local <ollama|lmstudio|llamacpp|vllm> [model-id] ...
  hybridclaw auth status local
  hybridclaw auth logout local

Examples:
  hybridclaw local configure lmstudio --base-url http://127.0.0.1:1234
  hybridclaw local configure lmstudio qwen/qwen3.5-9b --base-url http://127.0.0.1:1234
  hybridclaw local configure llamacpp Meta-Llama-3-8B-Instruct --base-url http://127.0.0.1:8081
  hybridclaw local configure ollama llama3.2
  hybridclaw local configure vllm mistralai/Mistral-7B-Instruct-v0.3 --base-url http://127.0.0.1:8000 --api-key secret

Notes:
  - \`hybridclaw local ...\` is deprecated and will be removed in a future release.
  - LM Studio, llama.cpp, and vLLM URLs are normalized to include \`/v1\`.
  - Ollama URLs are normalized to omit \`/v1\`.
  - When a model id is provided, \`configure\` also sets \`hybridai.defaultModel\` to that local model by default.
    Use \`--no-default\` to leave the global default model unchanged.
  - When no model id is provided, \`configure\` only enables the backend so you can browse models later with \`/model list <backend>\`.`);
}

export function printAuthUsage(): void {
  console.log(`Usage: hybridclaw auth <command> [provider] [options]

Commands:
  hybridclaw auth login
  hybridclaw auth login <hybridai|codex|openrouter|mistral|huggingface|local|msteams> ...
  hybridclaw auth status <hybridai|codex|openrouter|mistral|huggingface|local|msteams>
  hybridclaw auth logout <hybridai|codex|openrouter|mistral|huggingface|local|msteams>
  hybridclaw auth whatsapp reset

Examples:
  hybridclaw auth login
  hybridclaw auth login hybridai --browser
  hybridclaw auth login hybridai --base-url http://localhost:5000
  hybridclaw auth login codex --import
  hybridclaw auth login openrouter anthropic/claude-sonnet-4 --api-key sk-or-...
  hybridclaw auth login mistral mistral-large-latest --api-key mistral_...
  hybridclaw auth login huggingface meta-llama/Llama-3.1-8B-Instruct --api-key hf_...
  hybridclaw auth login local lmstudio --base-url http://127.0.0.1:1234
  hybridclaw auth login local ollama llama3.2
  hybridclaw auth login local llamacpp Meta-Llama-3-8B-Instruct --base-url http://127.0.0.1:8081
  hybridclaw auth login msteams --app-id 00000000-0000-0000-0000-000000000000 --tenant-id 11111111-1111-1111-1111-111111111111 --app-password secret
  hybridclaw auth whatsapp reset
  hybridclaw auth status openrouter
  hybridclaw auth status mistral
  hybridclaw auth status huggingface
  hybridclaw auth status msteams
  hybridclaw auth logout codex
  hybridclaw auth logout mistral
  hybridclaw auth logout huggingface
  hybridclaw auth logout msteams

Notes:
  - \`auth login\` without a provider runs the normal interactive onboarding flow.
  - \`local logout\` disables configured local backends and clears any saved vLLM API key.
  - \`auth login msteams\` enables Microsoft Teams and stores \`MSTEAMS_APP_PASSWORD\` in ${runtimeSecretsPath()}.
  - \`auth whatsapp reset\` clears linked WhatsApp Web auth so you can re-pair cleanly.
  - \`auth login openrouter\` prompts for the API key when \`--api-key\` and \`OPENROUTER_API_KEY\` are both absent.
  - \`auth login mistral\` prompts for the API key when \`--api-key\` and \`MISTRAL_API_KEY\` are both absent.
  - \`auth login huggingface\` prompts for the token when \`--api-key\` and \`HF_TOKEN\` are both absent.
  - \`auth login msteams\` prompts for the app id, app password, and optional tenant id when the terminal is interactive.`);
}

export function printChannelsUsage(): void {
  console.log(`Usage: hybridclaw channels <channel> <command>

Commands:
  hybridclaw channels discord setup [--token <token>] [--allow-user-id <snowflake>]... [--prefix <prefix>]
  hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...
  hybridclaw channels email setup [--address <email>] [--password <password>] [--imap-host <host>] [--imap-port <port>] [--imap-secure|--no-imap-secure] [--smtp-host <host>] [--smtp-port <port>] [--smtp-secure|--no-smtp-secure] [--folder <name>]... [--allow-from <email|*@domain|*>]... [--poll-interval-ms <ms>] [--text-chunk-limit <chars>] [--media-max-mb <mb>]
  hybridclaw channels imessage setup [--backend <local|remote>] [--allow-from <phone|email|chat:id>]... [--server-url <url>] [--password <password>] [--cli-path <path>] [--db-path <path>] [--webhook-path <path>] [--allow-private-network]

Notes:
  - Discord setup stores a bot token only when \`--token\` is provided.
  - Discord setup configures command-only mode and keeps guild access restricted by default.
  - WhatsApp setup starts a temporary pairing session and prints the QR code here when needed.
  - Use \`--reset\` to wipe stale WhatsApp auth files and force a fresh QR.
  - \`hybridclaw auth whatsapp reset\` clears linked WhatsApp auth without starting a new pairing session.
  - Without \`--allow-from\`, setup configures WhatsApp for self-chat only.
  - With one or more \`--allow-from\` values, setup enables only those DMs.
  - Groups stay disabled by default.
  - Email setup saves \`EMAIL_PASSWORD\` only when \`--password\` is provided or pasted interactively.
  - Email IMAP secure mode defaults to \`true\`.
  - Email SMTP secure mode defaults to \`false\` on port \`587\`; use \`--smtp-secure\` for implicit TLS on port \`465\`.
  - \`--no-smtp-secure\` is the correct setting for encrypted STARTTLS on port \`587\`; it does not force plaintext by itself.
  - Email inbound is explicit-opt-in: when email \`allowFrom\` is empty, inbound email is ignored.
  - Microsoft Teams setup lives under \`hybridclaw auth login msteams\` because it needs app credentials instead of a channel pairing flow.
  - iMessage setup defaults to the local macOS backend unless you pass \`--backend remote\`.
  - iMessage setup stores \`IMESSAGE_PASSWORD\` only when \`--password\` is provided for the remote relay backend.
  - Without \`--allow-from\`, inbound iMessage stays disabled and the channel is outbound-only.
  - Groups stay disabled by default for iMessage setup.
  - Discord activates automatically when \`DISCORD_TOKEN\` is configured.
  - iMessage activates automatically when \`imessage.enabled=true\`.
  - Email activates automatically when \`email.enabled=true\` and \`EMAIL_PASSWORD\` is configured.
  - WhatsApp activates automatically once linked auth exists.`);
}

export function printBrowserUsage(): void {
  console.log(`Usage: hybridclaw browser <command>

Commands:
  hybridclaw browser login [--url <url>]   Open a headed browser for manual login
  hybridclaw browser status                Show browser profile info
  hybridclaw browser reset                 Delete the persistent browser profile

Notes:
  - \`browser login\` opens Chromium with a persistent profile directory.
  - Log into any sites you want the agent to access (Google, GitHub, etc.).
  - Close the browser when done — sessions persist automatically.
  - The agent reuses these sessions for browser automation without needing credentials.
  - Profile data is stored under the HybridClaw data directory (configurable via HYBRIDCLAW_DATA_DIR; default: ~/.hybridclaw/data/browser-profiles/).
  - This directory contains persistent authenticated browser sessions — treat it as sensitive data.
  - Use \`browser reset\` to clear all saved sessions and start fresh.`);
}

export function printMigrationUsage(): void {
  console.log(`Usage:
  hybridclaw migrate openclaw [options]
  hybridclaw migrate hermes [options]

Notes:
  - Use \`migrate openclaw\` to import from \`~/.openclaw\`.
  - Use \`migrate hermes\` to import from \`~/.hermes\`.
  - Add \`--agent <id>\` to import into a specific HybridClaw agent instead of \`main\`.
  - Add \`--dry-run\` first to preview what will be imported.`);
}

export function printOpenClawMigrationUsage(): void {
  console.log(`Usage: hybridclaw migrate openclaw [options]

Options:
  --source <path>       Override the OpenClaw home directory (default: ~/.openclaw)
  --agent <id>          Import into a specific HybridClaw agent (default: main)
  --dry-run             Preview the migration without writing files
  --overwrite           Replace existing HybridClaw files and config values on conflict
  --migrate-secrets     Import compatible secrets into ${runtimeSecretsPath()}
  --force               Assume yes to all prompts

Notes:
  - Imports the parts of an OpenClaw home that map cleanly into HybridClaw.
  - Compatible workspace files land in the target agent workspace under \`~/.hybridclaw/data/agents/<agent>/workspace\`.
  - Compatible config values merge into ${runtimeConfigPath()} and secrets merge into ${runtimeSecretsPath()}.
  - A report is written under \`~/.hybridclaw/migration/openclaw/\` when the migration runs in execute mode.`);
}

export function printHermesMigrationUsage(): void {
  console.log(`Usage: hybridclaw migrate hermes [options]

Options:
  --source <path>       Override the Hermes home directory (default: ~/.hermes)
  --agent <id>          Import into a specific HybridClaw agent (default: main)
  --dry-run             Preview the migration without writing files
  --overwrite           Replace existing HybridClaw files and config values on conflict
  --migrate-secrets     Import compatible secrets into ${runtimeSecretsPath()}
  --force               Assume yes to all prompts

Notes:
  - Imports the parts of a Hermes Agent home that map cleanly into HybridClaw.
  - Compatible workspace files land in the target agent workspace under \`~/.hybridclaw/data/agents/<agent>/workspace\`.
  - Compatible config values merge into ${runtimeConfigPath()} and secrets merge into ${runtimeSecretsPath()}.
  - A report is written under \`~/.hybridclaw/migration/hermes/\` when the migration runs in execute mode.`);
}

export function printWhatsAppUsage(): void {
  console.log(`Usage:
  hybridclaw auth whatsapp reset
  hybridclaw channels whatsapp setup [--reset] [--allow-from <+E164>]...

Notes:
  - Only one running HybridClaw process may own the WhatsApp auth state at a time.
  - Use \`auth whatsapp reset\` to clear stale linked-device auth before re-pairing.
  - Use \`channels whatsapp setup\` to configure policy and open a fresh QR pairing session.`);
}

export function printMSTeamsUsage(): void {
  console.log(`Usage:
  hybridclaw auth login msteams [--app-id <id>|--client-id <id>] [--app-password <secret>|--client-secret <secret>] [--tenant-id <id>]
  hybridclaw auth status msteams
  hybridclaw auth logout msteams

Notes:
  - \`auth login msteams\` enables the Microsoft Teams integration in ${runtimeConfigPath()}.
  - \`auth login msteams\` stores \`MSTEAMS_APP_PASSWORD\` in ${runtimeSecretsPath()} and clears any plaintext \`msteams.appPassword\` value from config.
  - \`--tenant-id\` is optional.
  - If \`--app-password\` is omitted and \`MSTEAMS_APP_PASSWORD\` is already set, HybridClaw reuses that value.
  - If \`--app-id\` or \`--app-password\` is missing and the terminal is interactive, HybridClaw prompts for them and also offers an optional tenant id prompt.`);
}

export function printCodexUsage(): void {
  console.log(`Usage: hybridclaw codex <command> (deprecated)

Commands:
  hybridclaw codex login
  hybridclaw codex login --device-code
  hybridclaw codex login --browser
  hybridclaw codex login --import
  hybridclaw codex logout
  hybridclaw codex status

Use Instead:
  hybridclaw auth login codex ...
  hybridclaw auth logout codex
  hybridclaw auth status codex

Notes:
  - \`hybridclaw codex ...\` is deprecated and will be removed in a future release.`);
}

export function printHybridAIUsage(): void {
  console.log(`Usage: hybridclaw hybridai <command> (deprecated)

Commands:
  hybridclaw hybridai base-url [url]
  hybridclaw hybridai login [--device-code|--browser|--import] [--base-url <url>]
  hybridclaw hybridai logout
  hybridclaw hybridai status

Use Instead:
  hybridclaw auth login hybridai [--device-code|--browser|--import] [--base-url <url>]
  hybridclaw auth logout hybridai
  hybridclaw auth status hybridai

Notes:
  - \`hybridclaw hybridai base-url\` updates \`hybridai.baseUrl\` in ${runtimeConfigPath()}.
  - \`hybridclaw hybridai ...\` is deprecated and will be removed in a future release.`);
}

export function printOpenRouterUsage(): void {
  console.log(`Usage:
  hybridclaw auth login openrouter [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
  hybridclaw auth status openrouter
  hybridclaw auth logout openrouter

Notes:
  - Model IDs use the \`openrouter/\` prefix in HybridClaw, for example \`openrouter/anthropic/claude-sonnet-4\`.
  - If \`--api-key\` is omitted and \`OPENROUTER_API_KEY\` is unset, HybridClaw prompts you to paste the API key.
  - \`auth login openrouter\` stores \`OPENROUTER_API_KEY\`, enables the provider, and can set the global default model.
  - If the gateway is already running, OpenRouter config and credentials are picked up without a restart.
  - \`auth logout openrouter\` clears the stored API key but leaves runtime config unchanged.`);
}

export function printHuggingFaceUsage(): void {
  console.log(`Usage:
  hybridclaw auth login huggingface [model-id] [--api-key <token>] [--base-url <url>] [--no-default]
  hybridclaw auth status huggingface
  hybridclaw auth logout huggingface

Notes:
  - Model IDs use the \`huggingface/\` prefix in HybridClaw, for example \`huggingface/meta-llama/Llama-3.1-8B-Instruct\`.
  - If \`--api-key\` is omitted, HybridClaw prompts you to paste the token for explicit login.
  - \`auth login huggingface\` stores \`HF_TOKEN\`, enables the provider, and can set the global default model.
  - If the gateway is already running, Hugging Face config and credentials are picked up without a restart.
  - \`auth logout huggingface\` clears the stored token but leaves runtime config unchanged.`);
}

export function printMistralUsage(): void {
  console.log(`Usage:
  hybridclaw auth login mistral [model-id] [--api-key <key>] [--base-url <url>] [--no-default]
  hybridclaw auth status mistral
  hybridclaw auth logout mistral

Notes:
  - Model IDs use the \`mistral/\` prefix in HybridClaw, for example \`mistral/mistral-large-latest\`.
  - If \`--api-key\` is omitted and \`MISTRAL_API_KEY\` is unset, HybridClaw prompts you to paste the API key.
  - \`auth login mistral\` stores \`MISTRAL_API_KEY\`, enables the provider, and can set the global default model.
  - If the gateway is already running, Mistral config and credentials are picked up without a restart.
  - \`auth logout mistral\` clears the stored API key but leaves runtime config unchanged.`);
}

export function printAuditUsage(): void {
  console.log(`Usage: hybridclaw audit <command>

Commands:
  recent [n]                         Show recent structured audit entries
  recent session <sessionId> [n]     Show recent events for one session
  search <query> [n]                 Search structured audit events
  approvals [n] [--denied]           Show approval decisions
  verify <sessionId>                 Verify wire hash chain integrity
  instructions [--sync] [--approve]  Verify or restore runtime instruction files`);
}

export function printDoctorUsage(): void {
  console.log(`Usage:
  hybridclaw doctor
  hybridclaw doctor --fix
  hybridclaw doctor --json
  hybridclaw doctor <runtime|gateway|config|credentials|database|providers|local-backends|docker|channels|skills|security|disk>

Notes:
  - Runs independent diagnostic categories in parallel and reports ok, warning, and error states.
  - \`--fix\` retries fixable checks after applying automatic remediation where supported.
  - \`--json\` prints a machine-readable report and still uses exit code 1 when any errors remain.`);
}

export function printSkillUsage(): void {
  console.log(`Usage: hybridclaw skill <command>

Commands:
  hybridclaw skill list
  hybridclaw skill enable <skill-name> [--channel <kind>]
  hybridclaw skill disable <skill-name> [--channel <kind>]
  hybridclaw skill toggle [--channel <kind>]
  hybridclaw skill inspect <skill-name>
  hybridclaw skill inspect --all
  hybridclaw skill runs <skill-name>
  hybridclaw skill learn <skill-name>
  hybridclaw skill learn <skill-name> --apply
  hybridclaw skill learn <skill-name> --reject
  hybridclaw skill learn <skill-name> --rollback
  hybridclaw skill history <skill-name>
  hybridclaw skill sync [--skip-skill-scan] <source>
  hybridclaw skill import [--force] [--skip-skill-scan] <source>
  hybridclaw skill install <skill-name> [install-id]

Notes:
  - \`list\` shows declared install options from skill frontmatter.
  - Omit \`--channel\` to change the global disabled list.
  - \`--channel teams\` is normalized to \`msteams\`.
  - \`inspect\` shows observation-based health metrics for a skill or all observed skills.
  - \`runs\` shows recent execution observations for one skill.
  - \`learn\` stages, applies, rejects, or rolls back skill amendments.
  - \`history\` shows amendment versions for one skill, not execution runs.
  - \`sync\` is a convenience alias for \`import --force\` when you want to refresh an installed skill from the source without changing the source syntax.
  - \`import\` installs a packaged community skill with \`official/<skill-name>\` or imports a community skill from \`skills-sh/<owner>/<repo>/<skill>\`, \`clawhub/<skill-slug>\`, \`lobehub/<agent-id>\`, \`claude-marketplace/<skill>[@<marketplace>]\`, \`well-known:https://example.com/docs\`, or an explicit GitHub repo/path into \`~/.hybridclaw/skills\`.
  - Examples: \`official/himalaya\`, \`skills-sh/anthropics/skills/brand-guidelines\`, \`clawhub/brand-voice\`, \`lobehub/github-issue-helper\`, \`claude-marketplace/brand-guidelines@anthropic-agent-skills\`, \`well-known:https://mintlify.com/docs\`, \`anthropics/skills/skills/brand-guidelines\`.
  - \`import --force\` can override a \`caution\` scanner verdict for a community skill, but it never overrides a \`dangerous\` verdict.
  - \`install\` runs one declared installer (brew, uv, npm, go, download).`);
}

export function printToolUsage(): void {
  console.log(`Usage: hybridclaw tool <command>

Commands:
  hybridclaw tool list
  hybridclaw tool enable <tool-name>
  hybridclaw tool disable <tool-name>

Notes:
  - Tool disables are global and remove the tool from future agent turns.
  - Use \`list\` to see the built-in tool catalog and current enabled/disabled state.
  - MCP tools are managed through \`hybridclaw gateway mcp ...\`, not \`hybridclaw tool ...\`.`);
}

export function printPluginUsage(): void {
  console.log(`Usage: hybridclaw plugin <command>

Commands:
  hybridclaw plugin list
  hybridclaw plugin config <plugin-id> [key] [value|--unset]
  hybridclaw plugin enable <plugin-id>
  hybridclaw plugin disable <plugin-id>
  hybridclaw plugin install <path|npm-spec>
  hybridclaw plugin reinstall <path|npm-spec>
  hybridclaw plugin uninstall <plugin-id>

Examples:
  hybridclaw plugin list
  hybridclaw plugin config qmd-memory searchMode query
  hybridclaw plugin disable qmd-memory
  hybridclaw plugin enable qmd-memory
  hybridclaw plugin install ./plugins/example-plugin
  hybridclaw plugin install @scope/hybridclaw-plugin-example
  hybridclaw plugin reinstall ./plugins/example-plugin
  hybridclaw plugin uninstall example-plugin

Notes:
  - Plugins install into \`~/.hybridclaw/plugins/<plugin-id>\`.
  - Valid plugins in \`~/.hybridclaw/plugins/\` or \`./.hybridclaw/plugins/\` auto-discover at runtime.
  - \`list\` shows discovered plugin status, source, description, commands, tools, hooks, and load errors.
  - \`config\` edits top-level \`plugins.list[].config\` keys in ${runtimeConfigPath()}.
  - \`enable\` and \`disable\` manage the top-level \`plugins.list[].enabled\` override in ${runtimeConfigPath()}.
  - \`install\` validates \`hybridclaw.plugin.yaml\` and installs npm dependencies when needed.
  - \`reinstall\` replaces the home-installed plugin tree and preserves existing \`plugins.list[]\` overrides.
  - \`uninstall\` removes the home-installed plugin directory and matching \`plugins.list[]\` overrides.
  - Use ${runtimeConfigPath()} only for plugin overrides such as disable flags, config values, or custom paths.`);
}

export function printConfigUsage(): void {
  console.log(`Usage: hybridclaw config [check|reload|set <key> <value>]

Commands:
  hybridclaw config
  hybridclaw config check
  hybridclaw config reload
  hybridclaw config set <key> <value>
  hybridclaw config revisions [list|rollback <id>|delete <id>|clear]

Examples:
  hybridclaw config
  hybridclaw config check
  hybridclaw config reload
  hybridclaw config set hybridai.maxTokens 8192
  hybridclaw config revisions
  hybridclaw config revisions rollback 12
  hybridclaw config set discord.enabled true
  hybridclaw config set local.backends.ollama.models '["llama3.2"]'

Notes:
  - \`config\` prints the current runtime config from ${runtimeConfigPath()}.
  - \`check\` validates only the runtime config file itself.
  - \`reload\` forces an immediate in-process hot reload from disk, then runs a config check.
  - \`set\` only updates existing dotted key paths; it does not create new keys, then immediately runs a config check.
  - \`revisions\` lists saved config snapshots, including the actor and route that caused each tracked change.
  - Values are parsed as JSON when possible, otherwise they are stored as plain strings.`);
}

export function printAgentUsage(): void {
  console.log(`Usage: hybridclaw agent <command>

Commands:
  hybridclaw agent list
  hybridclaw agent export [agent-id] [-o <path>] [--description <text>] [--author <text>] [--version <value>] [--dry-run] [--skills <ask|active|all|some>] [--skill <name>]... [--plugins <ask|active|all|some>] [--plugin <id>]...
  hybridclaw agent inspect <file.claw>
  hybridclaw agent install <file.claw|https://.../*.claw|official:<agent-dir>|github:owner/repo/<agent-dir>> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--skip-import-errors] [--yes]
  hybridclaw agent activate <agent-id>
  hybridclaw agent uninstall <agent-id> [--yes]

Notes:
  - \`list\` prints registered agents in a script-friendly tab-separated format.
  - \`export\` exports an agent workspace, bundled workspace skills, and bundled home plugins into a portable \`.claw\` archive.
  - Use \`--description\`, \`--author\`, and \`--version\` to set optional manifest metadata during export.
  - Use \`--dry-run\` to preview the generated manifest path and archive entries without writing a file.
  - Use \`--skills active\` to bundle only enabled workspace skills, \`--skills all\` to bundle all workspace skills, or \`--skills some --skill <name>\` to bundle a selected subset.
  - Use \`--plugins active\` to bundle only enabled home plugins, \`--plugins all\` to bundle all installed home plugins, or \`--plugins some --plugin <id>\` to bundle a selected subset.
  - Interactive export defaults to \`--skills ask\` and \`--plugins ask\`; non-interactive export defaults to \`--skills all\` and \`--plugins active\`.
  - \`inspect\` validates the archive manifest and prints a summary without extracting files.
  - \`install\` validates ZIP safety, confirms the manifest, registers the agent, restores bundled content, installs manifest-declared skill imports into the agent workspace, and fills missing bootstrap files.
  - \`install official:<agent-dir>\` downloads a packaged agent from \`HybridAIOne/claws\` on GitHub before installing it.
  - \`install github:owner/repo/<agent-dir>\` resolves the packaged agent from a GitHub claws repo; use \`github:owner/repo/<ref>/<agent-dir>\` to pin a ref.
  - Direct \`https://.../*.claw\` URLs download the archive before installing it.
  - \`activate\` makes an installed agent the default for new requests that do not specify an agent explicitly.
  - \`uninstall\` removes a non-main agent registration and its workspace root.
  - Use \`--yes\` to skip the install or uninstall confirmation prompt.
  - Use \`--force\` to replace an existing agent workspace or bundled plugin install during install.
  - Use \`--skip-skill-scan\` to bypass the imported skill security scanner during install.
  - Use \`--skip-externals\` to skip manifest-declared imported skills and other external references during install.
  - Use \`--skip-import-errors\` to continue agent install when an imported skill fetch/install fails, and print retry commands instead.
  - Legacy aliases remain accepted: \`pack\` maps to \`export\`, and \`unpack\` maps to \`install\`.`);
}

export function printHelpUsage(): void {
  console.log(`Usage: hybridclaw help <topic>

Topics:
  agent       Help for portable agent archive commands
  auth        Help for unified provider login/logout/status
  gateway     Help for gateway lifecycle and passthrough commands
  tui         Help for terminal client
  onboarding  Help for onboarding flow
  channels    Help for channel setup helpers
  migrate     Help for agent-home migration
  openclaw    Help for OpenClaw migration
  hermes      Help for Hermes Agent migration
  config      Help for local runtime config commands
  plugin      Help for plugin management
  msteams     Help for Microsoft Teams auth/setup commands
  openrouter  Help for OpenRouter setup/status/logout commands
  mistral     Help for Mistral setup/status/logout commands
  huggingface Help for Hugging Face setup/status/logout commands
  whatsapp    Help for WhatsApp setup/reset commands
  skill       Help for skill installer commands
  tool        Help for built-in tool toggles
  update      Help for checking/applying CLI updates
  audit       Help for audit commands
  doctor      Help for diagnostics and auto-remediation
  help        This help`);
}

export function printDeprecatedProviderAliasWarning(
  provider: 'hybridai' | 'codex' | 'local',
  args: string[],
): void {
  const sub = (args[0] || '').trim().toLowerCase();
  let replacement = '';

  if (provider === 'local') {
    replacement =
      sub === 'status'
        ? 'hybridclaw auth status local'
        : sub === 'help' || sub === '--help' || sub === '-h'
          ? 'hybridclaw help local'
          : 'hybridclaw auth login local ...';
  } else {
    replacement =
      sub === 'status'
        ? `hybridclaw auth status ${provider}`
        : sub === 'logout'
          ? `hybridclaw auth logout ${provider}`
          : provider === 'hybridai' && sub === 'base-url'
            ? 'hybridclaw auth login hybridai --base-url <url>'
            : sub === 'help' || sub === '--help' || sub === '-h'
              ? `hybridclaw help ${provider}`
              : `hybridclaw auth login ${provider} ...`;
  }

  console.warn(
    `[deprecated] \`hybridclaw ${provider} ...\` is deprecated and will be removed in a future release. Use \`${replacement}\` instead.`,
  );
}

export function isHelpRequest(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0]?.toLowerCase();
  return first === 'help' || first === '--help' || first === '-h';
}

export async function printHelpTopic(topic: string): Promise<boolean> {
  switch (topic.trim().toLowerCase()) {
    case 'agent':
      printAgentUsage();
      return true;
    case 'auth':
      printAuthUsage();
      return true;
    case 'gateway':
      printGatewayUsage();
      return true;
    case 'tui':
      printTuiUsage();
      return true;
    case 'onboarding':
      printOnboardingUsage();
      return true;
    case 'channels':
      printChannelsUsage();
      return true;
    case 'config':
      printConfigUsage();
      return true;
    case 'plugin':
      printPluginUsage();
      return true;
    case 'msteams':
    case 'teams':
      printMSTeamsUsage();
      return true;
    case 'local':
      printLocalUsage();
      return true;
    case 'hybridai':
      printHybridAIUsage();
      return true;
    case 'codex':
      printCodexUsage();
      return true;
    case 'openrouter':
      printOpenRouterUsage();
      return true;
    case 'mistral':
      printMistralUsage();
      return true;
    case 'huggingface':
    case 'hf':
      printHuggingFaceUsage();
      return true;
    case 'browser':
      printBrowserUsage();
      return true;
    case 'migrate':
      printMigrationUsage();
      return true;
    case 'openclaw':
      printOpenClawMigrationUsage();
      return true;
    case 'hermes':
      printHermesMigrationUsage();
      return true;
    case 'whatsapp':
      printWhatsAppUsage();
      return true;
    case 'skill':
      printSkillUsage();
      return true;
    case 'tool':
      printToolUsage();
      return true;
    case 'update': {
      const { printUpdateUsage } = await import('../update.js');
      printUpdateUsage();
      return true;
    }
    case 'audit':
      printAuditUsage();
      return true;
    case 'doctor':
      printDoctorUsage();
      return true;
    case 'help':
      printHelpUsage();
      return true;
    default:
      return false;
  }
}
