# HybridClaw

Personal AI assistant bot for Discord, powered by HybridAI's bot platform.

## Architecture

- **Gateway service** (Node.js): shared chat/command runtime, SQLite, scheduler, heartbeat, web/API, optional Discord integration
- **TUI client**: thin gateway client over HTTP (`/api/chat`, `/api/command`)
- **Container** (Docker, ephemeral): HybridAI API client, tool executor
- Communication between host/container via file-based IPC (`input.json`/`output.json`)

## Key commands

- `npm run dev` — start gateway runtime
- `npm run tui` — start terminal UI client (connects to gateway)
- `hybridclaw onboarding` — run HybridAI account/API key onboarding flow
- `npm run build:container` — build container (compile TS + Docker image)

## API

- HybridAI: `POST {HYBRIDAI_BASE_URL}/v1/chat/completions` with `chatbot_id`, `enable_rag`
- Bot list: `GET {HYBRIDAI_BASE_URL}/api/v1/bot-management/bots`
- Onboarding/browser auth pages (fixed under `HYBRIDAI_BASE_URL`): `/register`, `/verify_code`, `/admin_api_keys`

## Structure

- `src/` — gateway runtime, adapters, DB, IPC, scheduler, heartbeat, health/web API
- `container/src/` — agent code (tools, HybridAI client, IPC)
- `data/` — runtime (gitignored): SQLite DB, session workspaces, IPC files

## Heartbeat

Periodic polls (default 30 min) so the agent can proactively check tasks and reach out.

- `src/heartbeat.ts` — `startHeartbeat()` / `stopHeartbeat()`
- Uses dedicated session `heartbeat:<agentId>` (keeps history separate, max 5 messages)
- Sends heartbeat prompt → agent checks `HEARTBEAT.md` → replies `HEARTBEAT_OK` or real content
- `HEARTBEAT_OK` responses are silently discarded (not stored, not displayed)
- Mutex prevents overlapping heartbeats
- Config: `HEARTBEAT_ENABLED` (default true), `HEARTBEAT_INTERVAL` (default 1800000ms), `HEARTBEAT_CHANNEL` (Discord channel ID)
- TUI: starts after bootstrap, prints responses inline
- Discord: starts after `ready` event, sends to `HEARTBEAT_CHANNEL` if set
