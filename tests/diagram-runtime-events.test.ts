import { describe, expect, test } from 'vitest';

import type { ToolExecution } from '../src/types/execution.js';

function buildToolExecution(
  overrides: Partial<ToolExecution> = {},
): ToolExecution {
  return {
    name: 'diagram_create',
    arguments: '{}',
    result: JSON.stringify({
      runtime_events: [
        {
          type: 'diagram.rendered',
          artifact_ref: '/workspace/.generated-diagrams/skills/diagram/a.svg',
          source_artifact_ref:
            '/workspace/.generated-diagrams/skills/diagram/a.mmd',
          diagram_type: 'flowchart',
          requested_type: 'auto',
          format: 'mermaid',
          render_to: 'svg',
          scope: { type: 'skill', id: 'diagram' },
        },
      ],
    }),
    durationMs: 10,
    ...overrides,
  };
}

describe('diagram runtime events', () => {
  test('builds trusted F2 runtime events from diagram tool outputs only', async () => {
    const { buildDiagramRuntimeEventsFromToolExecutions } = await import(
      '../src/gateway/diagram-runtime-events.js'
    );

    const events = buildDiagramRuntimeEventsFromToolExecutions({
      sessionId: 'session-a',
      runId: 'run-a',
      now: new Date('2026-05-14T08:00:00.000Z'),
      toolExecutions: [
        buildToolExecution(),
        buildToolExecution({
          name: 'bash',
          result: JSON.stringify({
            runtime_events: [{ type: 'diagram.rendered' }],
          }),
        }),
        buildToolExecution({
          name: 'diagram_validate',
          isError: true,
        }),
      ],
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'diagram.rendered',
        session_id: 'session-a',
        run_id: 'run-a',
        tool_name: 'diagram_create',
        created_at: '2026-05-14T08:00:00.000Z',
        artifact_ref: '/workspace/.generated-diagrams/skills/diagram/a.svg',
      }),
    ]);
  });

  test('emits diagram events on the existing runtime event bus', async () => {
    const { subscribeRuntimeEvents } = await import(
      '../src/skills/skill-run-events.js'
    );
    const { emitDiagramRuntimeEventsForToolExecutions } = await import(
      '../src/gateway/diagram-runtime-events.js'
    );
    const received: unknown[] = [];
    const unsubscribe = subscribeRuntimeEvents((event) => {
      received.push(event);
    });

    emitDiagramRuntimeEventsForToolExecutions({
      sessionId: 'session-b',
      runId: 'run-b',
      toolExecutions: [buildToolExecution()],
    });
    unsubscribe();

    expect(received).toEqual([
      expect.objectContaining({
        type: 'diagram.rendered',
        session_id: 'session-b',
        run_id: 'run-b',
      }),
    ]);
  });
});
