# Development Docs

These docs hold the deeper reference material that does not belong in the
top-level contributor quickstart.

- [Extensibility: Tools, Skills, and Plugins](./extensibility.md) for when to
  use each extension mechanism and how they compose
- [Architecture](./architecture.md) for the major runtime pieces and repository
  layout
- [Runtime Internals](./runtime.md) for sandboxing, configuration, diagnostics,
  audit, and observability behavior
- [Session Routing](./session-routing.md) for canonical session keys, DM
  isolation scope, and identity-link behavior
- [Voice and TTS](./voice-tts.md) for outbound voice-reply setup and local
  speech backend expectations
- [Testing Reference](./testing.md) for local checks, hooks, and test-suite
  boundaries
- [Release and Publishing](./releasing.md) for release tags and container
  publish flow
- [Skills Internals](./skills.md) for skill roots, precedence, and invocation
  rules
- [Plugin System](./plugins.md) for plugin manifests, runtime discovery,
  config wiring, install workflow, and runtime hooks
- [Agent Jobs and Dispatch](./agent-jobs-kanban.md) for the persistent shared
  workflow board spanning gateway APIs, the admin console, the TUI, and
  agent-side job mutations
- [QMD Memory Plugin](./qmd-memory-plugin.md) for the installable external
  markdown-search memory layer shipped in `plugins/qmd-memory`
- [Adaptive Skills](./adaptive-skills.md) for the self-improving skill loop,
  retention, and operator workflows
- [OpenTelemetry Tracing Plugin](./otel-plugin.md) for emitting OTLP traces
  to Langfuse, Jaeger, Grafana Tempo, or any OTLP backend
