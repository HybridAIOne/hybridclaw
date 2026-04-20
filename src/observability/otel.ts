/**
 * OpenTelemetry SDK initialization for HybridClaw gateway.
 *
 * Activates only when OTEL_ENABLED=true or OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * When inactive, all tracing calls are no-ops via the default @opentelemetry/api.
 */

import { context, SpanStatusCode, trace } from '@opentelemetry/api';

let sdkInstance: { shutdown(): Promise<void> } | null = null;

function isOtelRequested(): boolean {
  return (
    process.env.OTEL_ENABLED === 'true' ||
    Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
  );
}

/**
 * Initialize the OpenTelemetry SDK. Call this early in gateway startup,
 * before any traced code executes. Safe to call when OTel is not configured
 * — returns immediately as a no-op.
 */
export async function initOtel(): Promise<void> {
  if (!isOtelRequested() || sdkInstance) return;

  // Dynamic imports so the SDK packages are only loaded when OTel is active.
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '';
  const protocol = (
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL || 'grpc'
  ).toLowerCase();

  let traceExporter: ConstructorParameters<typeof NodeSDK>[0] extends
    | { traceExporter?: infer T }
    | undefined
    ? T
    : never;

  if (protocol === 'http/protobuf' || protocol === 'http') {
    const { OTLPTraceExporter } = await import(
      '@opentelemetry/exporter-trace-otlp-http'
    );
    traceExporter = new OTLPTraceExporter({
      url: endpoint || undefined,
    });
  } else {
    const { OTLPTraceExporter } = await import(
      '@opentelemetry/exporter-trace-otlp-grpc'
    );
    traceExporter = new OTLPTraceExporter({
      url: endpoint || undefined,
    });
  }

  const serviceName = process.env.OTEL_SERVICE_NAME || 'hybridclaw-gateway';

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': serviceName,
    }),
    traceExporter,
  });

  try {
    sdk.start();
  } catch (err) {
    // Log a warning but do not crash the gateway — tracing is optional.
    // eslint-disable-next-line no-console
    console.warn('Failed to start OpenTelemetry SDK:', err);
    return;
  }
  sdkInstance = sdk;
}

/**
 * Gracefully shut down the OTel SDK, flushing any pending spans.
 * Safe to call when OTel was never initialized.
 */
export async function shutdownOtel(): Promise<void> {
  const sdk = sdkInstance;
  if (!sdk) return;
  sdkInstance = null;
  await sdk.shutdown();
}

const TRACER_NAME = 'hybridclaw';

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Run an async function inside a new span. The span is automatically ended
 * and its status set based on whether the function throws.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    name,
    { attributes: cleanAttributes(attributes) },
    async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(
          err instanceof Error ? err : new Error(String(err)),
        );
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Run a synchronous function inside a new span. The span is automatically
 * ended and its status set based on whether the function throws.
 */
export function withSpanSync<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => T,
): T {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    name,
    { attributes: cleanAttributes(attributes) },
    (span) => {
      try {
        const result = fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(
          err instanceof Error ? err : new Error(String(err)),
        );
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Return the current active traceId and spanId (if any) for log correlation.
 * Returns empty strings when OTel is not active.
 */
export function getTraceContext(): { traceId: string; spanId: string } {
  const span = trace.getSpan(context.active());
  if (!span) return { traceId: '', spanId: '' };
  const ctx = span.spanContext();
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

// Strip undefined values so OTel doesn't complain.
function cleanAttributes(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const cleaned: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}
