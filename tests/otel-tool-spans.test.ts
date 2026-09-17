import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  captureActiveContext,
  recordCompletedSpan,
  withSpan,
} from '../src/observability/otel.js';

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  provider.register();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

test('recordCompletedSpan nests a finished tool call under the turn span', async () => {
  const endTime = Date.now();
  await withSpan(
    'hybridclaw.gateway.handle_message',
    { 'hybridclaw.session_id': 'sess-1' },
    async () => {
      const turnContext = captureActiveContext();
      // Simulate the IPC callback: it runs outside the turn's async context.
      await new Promise<void>((resolve) => {
        context.with(context.ROOT_CONTEXT, () => {
          recordCompletedSpan(
            'hybridclaw.tool.execute',
            {
              'hybridclaw.tool_name': 'read',
              'gen_ai.tool.name': 'read',
              'langfuse.observation.type': 'tool',
              'hybridclaw.agent_id': undefined,
            },
            { startTime: endTime - 250, endTime },
            turnContext,
          );
          resolve();
        });
      });
    },
  );

  const spans = exporter.getFinishedSpans();
  const turn = spans.find(
    (span) => span.name === 'hybridclaw.gateway.handle_message',
  );
  const tool = spans.find((span) => span.name === 'hybridclaw.tool.execute');
  expect(turn).toBeDefined();
  expect(tool).toBeDefined();
  expect(tool?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId);
  expect(tool?.spanContext().traceId).toBe(turn?.spanContext().traceId);
  expect(tool?.attributes).toEqual({
    'hybridclaw.tool_name': 'read',
    'gen_ai.tool.name': 'read',
    'langfuse.observation.type': 'tool',
  });
  const [seconds, nanos] = tool!.duration;
  expect(Math.round(seconds * 1000 + nanos / 1e6)).toBe(250);
});

test('recordCompletedSpan is a no-op without a registered provider', async () => {
  await provider.shutdown();
  trace.disable();
  expect(() =>
    recordCompletedSpan('hybridclaw.tool.execute', {}, {
      startTime: Date.now() - 1,
      endTime: Date.now(),
    }),
  ).not.toThrow();
});
