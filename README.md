# HybridClaw

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
cd container && npm run build && docker build -t hybridclaw-agent . && cd ..

# Run Discord bot
npm run dev

# Or run the terminal UI (no Discord needed)
npm run tui
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

## Agent tools

The agent has access to these sandboxed tools inside the container:

- `read` / `write` / `edit` / `delete` — file operations
- `glob` / `grep` — file search
- `bash` — shell command execution

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
