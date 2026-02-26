# HybridClaw

<img width="656" height="621" alt="image" src="https://github.com/user-attachments/assets/59507ace-bd27-40ff-a8e8-0fd6b9af2aa1" />

Personal AI assistant bot for Discord, powered by [HybridAI](https://hybridai.one).

## Architecture

- **Host process** (Node.js) — Discord client, SQLite persistence, scheduler, IPC, heartbeat
- **Container** (Docker, ephemeral) — HybridAI API client, sandboxed tool executor
- Communication via file-based IPC (input.json / output.json)

## Quick start

```bash
# Install dependencies
npm install
cd container && npm install && cd ..

# Copy and fill in your credentials
cp .env.example .env

# Build the container image
npm run build:container

# Link the CLI globally
npm link

# Run Discord bot
hybridclaw serve

# Or run the terminal UI (no Discord needed)
hybridclaw tui
```

## Configuration

See `.env.example` for all options. Required:

- `DISCORD_TOKEN` — Discord bot token
- `HYBRIDAI_API_KEY` — HybridAI API key
- `HYBRIDAI_CHATBOT_ID` — Default chatbot ID (overridable per channel)

## Agent workspace

Each agent gets a persistent workspace with markdown files that shape its personality and memory:

| File | Purpose |
|------|---------|
| `SOUL.md` | Personality, tone, identity |
| `IDENTITY.md` | Name, avatar, emoji |
| `USER.md` | Info about the human |
| `MEMORY.md` | Persistent memory across sessions |
| `AGENTS.md` | Workspace conventions and rules |
| `TOOLS.md` | Environment-specific notes |
| `HEARTBEAT.md` | Periodic tasks |
| `BOOT.md` | Startup instructions |

Templates in `templates/` are copied to new agent workspaces on first run.

## Skills

HybridClaw supports CLAUDE/OpenClaw-style skills (`<skill-name>/SKILL.md`).

### Where to put skills

You can place skills in:

- `./skills/<skill-name>/SKILL.md` (project-level)
- `<agent workspace>/skills/<skill-name>/SKILL.md` (agent-specific)
- `$CODEX_HOME/skills/<skill-name>/SKILL.md`, `~/.codex/skills/<skill-name>/SKILL.md`, or `~/.claude/skills/<skill-name>/SKILL.md` (managed/shared)

Load precedence is:

- managed/shared < project < agent workspace

### Required format

Each skill must be a folder with a `SKILL.md` file and frontmatter:

```markdown
---
name: repo-orientation
description: Quickly map an unfamiliar repository and identify where a requested feature should be implemented.
user-invocable: true
disable-model-invocation: false
---

# Repo Orientation
...instructions...
```

Supported frontmatter keys:

- `name` (required)
- `description` (required)
- `user-invocable` (optional, default `true`)
- `disable-model-invocation` (optional, default `false`)

### Using skills

Skills are listed to the model as metadata (`name`, `description`, `location`), and the model reads `SKILL.md` on demand with the `read` tool.

Explicit invocation is supported via:

- `/skill <name> [input]`
- `/skill:<name> [input]`
- `/<name> [input]` (when `user-invocable: true`)

Example skill in this repo:

- `skills/repo-orientation/SKILL.md`

## Agent tools

The agent has access to these sandboxed tools inside the container:

- `read` / `write` / `edit` / `delete` — file operations
- `glob` / `grep` — file search
- `bash` — shell command execution
- `web_fetch` — fetch a URL and extract readable content (HTML → markdown/text)

## Commands

In Discord, use `!claw help` to see all commands. Key ones:

- `!claw <message>` — Talk to the agent
- `!claw bot set <id>` — Set chatbot for this channel
- `!claw model set <name>` — Set model for this channel
- `!claw rag on/off` — Toggle RAG
- `!claw clear` — Clear conversation history
- `!claw schedule add "<cron>" <prompt>` — Add scheduled task

## Project structure

```
src/              Host process (Discord, DB, IPC, container runner, scheduler)
container/src/    Agent code (tools, HybridAI client, IPC)
templates/        Workspace bootstrap files
data/             Runtime data (gitignored): SQLite DB, sessions, agent workspaces
```
