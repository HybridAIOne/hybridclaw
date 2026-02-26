# Changelog

## [0.1.1](https://github.com/HybridAIOne/hybridclaw/tree/v0.1.1)

### Added

- **Skills system**: CLAUDE/OpenClaw-compatible `SKILL.md` discovery with multi-source loading (managed `~/.codex/skills`, `~/.claude/skills`, project `skills/`, agent workspace `skills/`) and precedence-based resolution
- **Skill invocation**: Explicit `/skill <name>`, `/skill:<name>`, and `/<name>` slash-command support with automatic SKILL.md body expansion
- **Skill syncing**: Non-workspace skills are mirrored into the agent workspace so the container can read them via `/workspace/...` paths
- **Read tool pagination**: `offset` and `limit` parameters for reading large files, with line/byte truncation limits (2000 lines / 50KB) and continuation hints
- **TUI `/skill` command**: Help text and pass-through for skill invocations in the terminal UI
- **Example skills**: `repo-orientation` and `current-time` skills in `skills/`
- **Tool progress events**: Live tool execution updates streamed to Discord and TUI via stderr parsing, with a typed `ToolProgressEvent` pipeline from container runner to UI layers

### Changed

- **Container iteration limit**: Increased `MAX_ITERATIONS` from 12 to 20
- **Skills prompt format**: Switched from inline skill content to compact XML metadata; model now reads SKILL.md on demand via `read` tool
- **TUI unknown slash commands**: Unrecognized `/` commands now fall through to the message processor instead of printing an error, enabling direct `/<skill-name>` invocation
- **Read tool**: Replaced simple `abbreviate()` output with structured truncation including byte-size awareness and user-friendly continuation messages
- **Path safety**: `safeJoin` now throws on workspace-escape attempts instead of silently resolving
- **Tool progress UX**: Progress behavior is now built-in (no env toggles), Discord uses `🦞 running ...`, and TUI shows one transient line per tool invocation that is cleared after completion so only the final `🦞 tools: ...` summary remains
- **TUI interrupt UX**: `ESC`, `/stop`, and `/abort` now interrupt the active run and return control to the prompt; abort propagates through the host/container pipeline and stops the active container request promptly

### Fixed

- **Skill invocation in history**: Last user message in conversation history is now expanded for skill invocations, ensuring replayed context includes skill instructions
