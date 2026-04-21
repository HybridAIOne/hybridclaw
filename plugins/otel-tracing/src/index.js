// Per-turn OpenTelemetry instrumentation for HybridClaw.
//
// This plugin piggybacks on the gateway's built-in OTel SDK
// (src/observability/otel.ts). When OTEL_ENABLED=true the gateway
// registers a global tracer provider + OTLP exporter; this plugin just
// subscribes to lifecycle hooks and emits `agent.turn` / `tool.<name>`
// spans with gen_ai.* attributes through that provider.
//
// No message bodies, no tool arguments, and no response text end up on
// spans by default — on platform-hosted deployments the container runs
// customer conversations and anything we put on a span leaves our
// control into whatever OTLP backend the collector forwards to.

import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = 'hybridclaw-agent';
const TRACER_VERSION = '0.1.0';

const MAX_RESULT_TEXT_CHARS = 256;

export default {
  id: 'otel-tracing',

  register(api) {
    if (process.env.OTEL_ENABLED !== 'true') {
      api.logger.info(
        'OTEL_ENABLED is not "true"; otel-tracing plugin will no-op',
      );
      return;
    }

    const cfg = api.pluginConfig || {};
    const includeToolArguments = cfg.includeToolArguments === true;
    const includeResultText = cfg.includeResultText === true;

    const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);

    // sessionId -> { span, context }
    const activeSpans = new Map();

    api.on('before_agent_start', ({ sessionId, userId, agentId, model }) => {
      const span = tracer.startSpan('agent.turn', {
        kind: SpanKind.SERVER,
        attributes: {
          'gen_ai.system': 'hybridclaw',
          'gen_ai.request.model': model || 'unknown',
          'hybridclaw.session_id': sessionId,
          'hybridclaw.user_id': userId,
          'hybridclaw.agent_id': agentId,
        },
      });
      activeSpans.set(sessionId, {
        span,
        ctx: trace.setSpan(context.active(), span),
      });
    });

    api.on(
      'after_tool_call',
      ({ sessionId, toolName, arguments: args, isError }) => {
        const active = activeSpans.get(sessionId);
        if (!active) return;

        const toolSpan = tracer.startSpan(
          `tool.${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              'tool.name': toolName,
              'tool.is_error': Boolean(isError),
              ...(includeToolArguments && args
                ? { 'tool.arguments_json': safeStringify(args) }
                : {}),
            },
          },
          active.ctx,
        );
        if (isError) {
          toolSpan.setStatus({ code: SpanStatusCode.ERROR });
        } else {
          toolSpan.setStatus({ code: SpanStatusCode.OK });
        }
        toolSpan.end();
      },
    );

    api.on('agent_end', (ctx) => {
      const active = activeSpans.get(ctx.sessionId);
      if (!active) return;

      const { span } = active;
      span.setAttribute('gen_ai.response.model', ctx.model || 'unknown');
      span.setAttribute('hybridclaw.tool_count', ctx.toolNames.length);
      if (ctx.toolNames.length > 0) {
        span.setAttribute('hybridclaw.tools', ctx.toolNames.join(','));
      }
      if (ctx.durationMs != null) {
        span.setAttribute('hybridclaw.duration_ms', ctx.durationMs);
      }
      if (ctx.tokenUsage) {
        span.setAttribute(
          'gen_ai.usage.prompt_tokens',
          ctx.tokenUsage.promptTokens,
        );
        span.setAttribute(
          'gen_ai.usage.completion_tokens',
          ctx.tokenUsage.completionTokens,
        );
        span.setAttribute(
          'gen_ai.usage.total_tokens',
          ctx.tokenUsage.totalTokens,
        );
        span.setAttribute(
          'hybridclaw.model_calls',
          ctx.tokenUsage.modelCalls,
        );
      }
      if (includeResultText && typeof ctx.resultText === 'string') {
        span.setAttribute(
          'gen_ai.response.text_preview',
          ctx.resultText.slice(0, MAX_RESULT_TEXT_CHARS),
        );
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      activeSpans.delete(ctx.sessionId);
    });

    api.registerService({
      id: 'otel-tracing',
      async stop() {
        for (const { span } of activeSpans.values()) {
          span.end();
        }
        activeSpans.clear();
      },
    });

    api.logger.info(
      { includeToolArguments, includeResultText },
      'otel-tracing plugin registered',
    );
  },
};

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
