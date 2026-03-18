# OpenTelemetry Tracing Plugin

This guide shows how to build a HybridClaw plugin that emits OpenTelemetry
traces for every agent turn, with child spans for tool calls. Works with any
OTLP-compatible backend (Langfuse, Jaeger, Grafana Tempo, Honeycomb, etc.).

## How It Works

The plugin uses lifecycle hooks that fire **automatically on every turn** —
no tool call decision by the model is needed:

| Hook | Fires | Use |
|---|---|---|
| `before_agent_start` | Every turn, before model call | Create root span |
| `after_tool_call` | Each tool invocation | Create child span |
| `agent_end` | Every turn, after model responds | Close root span with usage |

## Plugin Structure

```
~/.hybridclaw/plugins/otel-tracing/
  hybridclaw.plugin.yaml
  index.js
  package.json
```

## Manifest

```yaml
# hybridclaw.plugin.yaml
id: otel-tracing
name: OpenTelemetry Tracing
version: 1.0.0
kind: tool
description: Emit OTLP traces for agent turns and tool calls
requires:
  env: [OTEL_EXPORTER_OTLP_ENDPOINT]
configSchema:
  type: object
  properties:
    serviceName:
      type: string
      default: hybridclaw
    resourceAttributes:
      type: object
      default: {}
```

## package.json

```json
{
  "name": "hybridclaw-plugin-otel-tracing",
  "private": true,
  "type": "module",
  "dependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-trace-node": "^1.30.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
    "@opentelemetry/resources": "^1.30.0",
    "@opentelemetry/semantic-conventions": "^1.28.0"
  }
}
```

## Plugin Code

```js
// index.js
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export default {
  id: 'otel-tracing',

  register(api) {
    const cfg = api.pluginConfig;
    const endpoint = api.getCredential('OTEL_EXPORTER_OTLP_ENDPOINT');

    // Initialize OTLP provider
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: cfg.serviceName || 'hybridclaw',
      ...cfg.resourceAttributes,
    });
    const provider = new NodeTracerProvider({ resource });
    const exporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers: api.getCredential('OTEL_EXPORTER_OTLP_HEADERS')
        ? Object.fromEntries(
            api.getCredential('OTEL_EXPORTER_OTLP_HEADERS')
              .split(',')
              .map((h) => h.split('=').map((s) => s.trim())),
          )
        : {},
    });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    provider.register();

    const tracer = trace.getTracer('hybridclaw-agent', '1.0.0');

    // Track active spans per session
    const activeSpans = new Map();

    // --- before_agent_start: create root span ---
    api.on('before_agent_start', ({ sessionId, userId, agentId, model }) => {
      const span = tracer.startSpan('agent.turn', {
        kind: SpanKind.SERVER,
        attributes: {
          'hybridclaw.session_id': sessionId,
          'hybridclaw.user_id': userId,
          'hybridclaw.agent_id': agentId,
          'gen_ai.system': 'hybridclaw',
          'gen_ai.request.model': model || 'unknown',
        },
      });
      activeSpans.set(sessionId, {
        span,
        context: trace.setSpan(context.active(), span),
      });
    });

    // --- after_tool_call: child span per tool ---
    api.on('after_tool_call', ({ sessionId, toolName, result, isError }) => {
      const active = activeSpans.get(sessionId);
      if (!active) return;

      const toolSpan = tracer.startSpan(
        `tool.${toolName}`,
        { kind: SpanKind.INTERNAL },
        active.context,
      );
      toolSpan.setAttribute('tool.name', toolName);
      toolSpan.setAttribute('tool.is_error', isError);
      if (isError) {
        toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: result });
      }
      toolSpan.end();
    });

    // --- agent_end: close root span with usage ---
    api.on('agent_end', (ctx) => {
      const active = activeSpans.get(ctx.sessionId);
      if (!active) return;

      const { span } = active;
      span.setAttribute('gen_ai.response.model', ctx.model || 'unknown');
      span.setAttribute('hybridclaw.tool_count', ctx.toolNames.length);
      span.setAttribute('hybridclaw.tools', ctx.toolNames.join(','));

      if (ctx.durationMs != null) {
        span.setAttribute('hybridclaw.duration_ms', ctx.durationMs);
      }
      if (ctx.tokenUsage) {
        span.setAttribute('gen_ai.usage.prompt_tokens', ctx.tokenUsage.promptTokens);
        span.setAttribute('gen_ai.usage.completion_tokens', ctx.tokenUsage.completionTokens);
        span.setAttribute('gen_ai.usage.total_tokens', ctx.tokenUsage.totalTokens);
        span.setAttribute('hybridclaw.model_calls', ctx.tokenUsage.modelCalls);
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      activeSpans.delete(ctx.sessionId);
    });

    // --- shutdown: flush pending spans ---
    api.registerService({
      id: 'otel-tracing',
      async stop() {
        activeSpans.clear();
        await provider.shutdown();
      },
    });

    api.logger.info({ endpoint }, 'OpenTelemetry tracing plugin registered');
  },
};
```

## Install and Enable

```bash
# Install the plugin
hybridclaw plugin install ./plugins/otel-tracing

# Set the OTLP endpoint
# Add OTEL_EXPORTER_OTLP_ENDPOINT to your environment or credentials.json

# Restart or reload
hybridclaw gateway restart --foreground
# or in-session:
/plugin reload
```

## Verify

```
/plugin list
```

Should show:
```
otel-tracing v1.0.0 [home]
  enabled: yes
  tools: (none)
  hooks: before_agent_start, after_tool_call, agent_end
```

Send any message in the TUI. Check your OTLP backend for a trace named
`agent.turn` with attributes like `gen_ai.usage.total_tokens` and child
spans named `tool.<name>` for each tool call.

## Backend-Specific Notes

### Langfuse

Set endpoint to your Langfuse OTLP ingestion URL:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(publicKey:secretKey)>
```

### Jaeger

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### Grafana Tempo

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

## Available Hook Data

### `before_agent_start`

- `sessionId`, `userId`, `agentId`, `channelId` — identity
- `model` — resolved model name (e.g., `openai-codex/gpt-5.4`)

### `after_tool_call`

- `toolName` — tool that was called
- `arguments` — arguments passed to the tool
- `result` — string result
- `isError` — whether the tool errored

### `agent_end`

- `resultText` — the assistant's response
- `toolNames` — list of tools called during the turn
- `model` — resolved model name
- `durationMs` — total turn wall-clock time
- `tokenUsage.promptTokens` — input tokens
- `tokenUsage.completionTokens` — output tokens
- `tokenUsage.totalTokens` — total tokens
- `tokenUsage.modelCalls` — number of LLM round-trips (>1 when tools are used)
- `messages` — full `StoredMessage[]` for the turn
