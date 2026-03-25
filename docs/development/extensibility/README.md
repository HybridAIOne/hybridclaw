---
title: Extensibility
description: How HybridClaw tools, skills, and plugins differ, when to use each one, and how they compose.
sidebar_position: 1
---

# Extensibility: Tools, Skills, and Plugins

HybridClaw has three extension mechanisms. They serve different purposes,
operate at different layers, and are designed to complement each other.

## Quick Comparison

| | Tools | Skills | Plugins |
|---|---|---|---|
| **What it is** | A function the model can call | A markdown prompt the model reads | A runtime module that registers code |
| **Language** | Built into container runtime (JS/TS) | Markdown with YAML frontmatter | JavaScript or TypeScript |
| **Runs where** | Inside the Docker sandbox | Injected into the system prompt | On the gateway (host process) |
| **Who writes it** | Core developers | Anyone (operators, agents) | Plugin developers |
| **Install** | Ship with the codebase | Drop a `SKILL.md` file | `hybridclaw plugin install` or drop a directory |
| **Hot reload** | Requires rebuild | Immediate (loaded per turn) | `/plugin reload` in session |
| **Config needed** | Code change | None | `hybridclaw.plugin.yaml` manifest |
| **Example** | `read`, `write`, `web_fetch`, `bash` | `pdf`, `github-pr-workflow`, `notion` | `calculator`, `honcho-memory` |

## Tools (Container Runtime)

Tools are the lowest-level extension point. They are functions registered in
`container/src/tools.ts` that the model can call during a turn. Each tool has
a JSON Schema definition (name, description, parameters) and a handler that
executes inside the sandboxed Docker container.

**Strengths:**
- Full sandbox isolation — tools run inside ephemeral containers with
  restricted filesystem, network, and resource access
- Direct access to workspace files, browser automation, MCP servers
- Approval tiers (green/yellow/red) gate dangerous operations

**When to use:**
- You need file I/O, shell execution, or browser control
- The operation must run in the sandbox for security
- You are modifying the core HybridClaw runtime

**Limitations:**
- Requires a code change and container rebuild
- Cannot access gateway state, memory layers, or plugin config
- Adding a tool means modifying the core codebase

## Skills (Prompt Injection)

Skills are `SKILL.md` markdown files with YAML frontmatter. They are injected
into the system prompt before each turn, giving the model instructions,
workflows, constraints, and domain knowledge. Skills do not execute code
themselves — they guide the model on _how_ to use existing tools.

**Strengths:**
- Zero code required — pure markdown
- Immediate effect — loaded fresh each turn, no restart needed
- Composable — multiple skills can be active simultaneously
- User-invocable via `/skill-name` syntax in chat
- Adaptive — the skill observation system can propose amendments based on
  usage patterns

**When to use:**
- You want to teach the model a workflow (e.g., "how to create a PR")
- You need domain-specific instructions (e.g., "Stripe API patterns")
- You want operator-editable behavior without code changes
- You want the model to combine existing tools in a specific way

**Limitations:**
- Cannot execute code or register new tools
- Consumes system prompt token budget
- Effectiveness depends on model instruction-following

**Skill sources** (in precedence order):
`extra` < `bundled` < `codex` < `claude` < `agents-personal` <
`agents-project` < `workspace`

## Plugins (Gateway Runtime)

Plugins are JavaScript/TypeScript modules that run on the gateway process. They
register runtime surfaces through the `HybridClawPluginApi`:

- **Plugin tools** — callable by the model, executed on the gateway (not in
  the sandbox), routed via HTTP bridge
- **Memory layers** — inject context into prompts and capture turns for
  external memory systems
- **Prompt hooks** — programmatically add content to the system prompt
- **Lifecycle hooks** — react to session, tool, compaction, and gateway events
- **Services** — long-running background processes
- **Channels, providers, commands** — extend the gateway itself

**Strengths:**
- Full Node.js runtime on the host — access npm packages, network, databases
- Register new tools without modifying core code
- Memory layer composition alongside built-in SQLite
- Lifecycle hooks for observability and side effects
- Config schema validation and credential management
- Hot reload via `/plugin reload`

**When to use:**
- You need a tool that calls an external API (no sandbox restrictions needed)
- You want to integrate an external memory or context system (e.g., Honcho,
  LanceDB)
- You need to react to lifecycle events (session start/end, tool calls,
  compaction)
- You want to distribute an extension as a standalone package

**Limitations:**
- Plugin tools run on the gateway, not in the sandbox — no filesystem or
  browser access inside the agent workspace
- Plugins must be synchronous at registration time (`register(api)` cannot
  return a promise)
- Requires a manifest file and entrypoint

## When to Use What

| Scenario | Use |
|---|---|
| Add a shell command or file operation | **Tool** (container) |
| Teach the model a multi-step workflow | **Skill** |
| Call an external API from the model | **Plugin tool** |
| Integrate external memory (Honcho, vector DB) | **Plugin memory layer** |
| Log every tool call to an external system | **Plugin lifecycle hook** |
| Guide the model on how to use Stripe | **Skill** |
| Add a new LLM provider | **Plugin provider** |
| Add a new chat channel | **Plugin channel** |
| Operator-editable agent behavior | **Skill** |
| Distributable npm extension package | **Plugin** |

## How They Compose

A typical integration uses multiple mechanisms together:

1. A **plugin** registers a memory layer that calls Honcho for user context
2. A **skill** tells the model when and how to leverage that context
3. Built-in **tools** (read, write, bash) handle the actual work

Another example:

1. A **plugin** registers a `stripe_charge` tool that calls the Stripe API
2. A **skill** (`skills/stripe/SKILL.md`) teaches the model Stripe workflows,
   error handling patterns, and idempotency rules
3. The model combines the plugin tool with built-in tools (read config files,
   write reports) following the skill's guidance

## File Locations

| Extension | Location |
|---|---|
| Tools | `container/src/tools.ts` |
| Skills | `skills/<name>/SKILL.md`, agent workspace, `config.skills.extraDirs` |
| Plugins | `~/.hybridclaw/plugins/<id>/`, `.hybridclaw/plugins/<id>/` |
| Plugin docs | `docs/development/extensibility/plugins.md` |
| Skill docs | `docs/development/extensibility/skills.md` |

## CLI and Session Commands

```bash
# Skills
hybridclaw skill list
hybridclaw skill enable <name>
hybridclaw skill disable <name>
hybridclaw skill inspect <name>
hybridclaw skill runs <name>
hybridclaw skill learn <name> [--apply|--reject|--rollback]
hybridclaw skill history <name>
hybridclaw skill import [--force] [--skip-skill-scan] <source>
/skill-name [input]              # invoke in session
/skill import [--force] [--skip-skill-scan] <source> # TUI/web slash import
/skill learn <name> [--apply|--reject|--rollback] # TUI/web slash amendment flow

# Agent packages
hybridclaw agent export [agent-id] [-o <path>]
hybridclaw agent inspect <file.claw>
hybridclaw agent install <file.claw> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--yes]
hybridclaw agent uninstall <agent-id> [--yes]

# Plugins
hybridclaw plugin list
hybridclaw plugin config <plugin-id> [key] [value|--unset]
hybridclaw plugin install <path|npm-spec>
hybridclaw plugin reinstall <path|npm-spec>
hybridclaw plugin uninstall <plugin-id>
/plugin list                     # in session
/plugin config <plugin-id> ...   # inspect or change top-level config keys
/plugin reload                   # in session — hot reload after code changes
/plugin uninstall <plugin-id>    # in session
```

For the `.claw` archive layout and manifest fields, see
[Agent Packages (`.claw`)](./agent-packages.md).
