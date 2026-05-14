import {
  emitRuntimeEvent,
  type RuntimeEventPayload,
} from '../skills/skill-run-events.js';
import type { ToolExecution } from '../types/execution.js';

const DIAGRAM_TOOL_NAMES = new Set([
  'diagram.create',
  'diagram.update',
  'diagram.validate',
  'diagram_create',
  'diagram_update',
  'diagram_validate',
]);

function parseRuntimeEvents(result: string): RuntimeEventPayload[] {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    const events = (parsed as { runtime_events?: unknown }).runtime_events;
    if (!Array.isArray(events)) return [];
    return events.filter(
      (event): event is RuntimeEventPayload =>
        Boolean(event) &&
        typeof event === 'object' &&
        !Array.isArray(event) &&
        ((event as { type?: unknown }).type === 'diagram.rendered' ||
          (event as { type?: unknown }).type === 'diagram.validation_failed'),
    );
  } catch {
    return [];
  }
}

export function buildDiagramRuntimeEventsFromToolExecutions(params: {
  sessionId: string;
  runId: string;
  toolExecutions: ToolExecution[];
  now?: Date;
}): RuntimeEventPayload[] {
  const createdAt = (params.now ?? new Date()).toISOString();
  const events: RuntimeEventPayload[] = [];
  for (const execution of params.toolExecutions) {
    if (!DIAGRAM_TOOL_NAMES.has(execution.name) || execution.isError) continue;
    for (const event of parseRuntimeEvents(execution.result)) {
      events.push({
        ...event,
        session_id: params.sessionId,
        run_id: params.runId,
        tool_name: execution.name,
        created_at: createdAt,
      });
    }
  }
  return events;
}

export function emitDiagramRuntimeEventsForToolExecutions(params: {
  sessionId: string;
  runId: string;
  toolExecutions: ToolExecution[];
}): void {
  for (const event of buildDiagramRuntimeEventsFromToolExecutions(params)) {
    emitRuntimeEvent(event);
  }
}
