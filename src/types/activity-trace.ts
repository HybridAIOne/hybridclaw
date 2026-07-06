/**
 * Ordered activity trace for one assistant turn — intermediate assistant
 * drafts, thinking segments, and tool calls the gateway streams to the web
 * chat, in the order they occurred.
 *
 * Persisted per assistant message so a page reload can replay the same trace
 * the web client rendered live. The step shape mirrors the console's live
 * trace so hydration is a near-identity map.
 */

export interface ActivityTraceThinkingStep {
  kind: 'thinking';
  text: string;
}

export interface ActivityTraceDraftStep {
  kind: 'draft';
  text: string;
}

export interface ActivityTraceToolStep {
  kind: 'tool';
  toolName: string;
  status: 'running' | 'done';
  argsPreview?: string;
  resultPreview?: string;
  durationMs?: number;
}

export type ActivityTraceStep =
  | ActivityTraceThinkingStep
  | ActivityTraceDraftStep
  | ActivityTraceToolStep;

export interface ActivityTrace {
  steps: ActivityTraceStep[];
  /** Wall-clock duration of the turn, for the collapsed summary line. */
  elapsedMs?: number;
}

/**
 * Accumulates streamed draft/thinking/tool events into an ordered trace.
 * Consecutive thinking deltas merge, and a tool `finish` collapses into the
 * most recent matching running `start` (parallel same-name tools can finish out
 * of order).
 */
export class ActivityTraceBuilder {
  private readonly steps: ActivityTraceStep[] = [];

  pushThinking(delta: string): void {
    if (!delta) return;
    const last = this.steps.at(-1);
    if (last?.kind === 'thinking') {
      last.text += delta;
    } else {
      this.steps.push({ kind: 'thinking', text: delta });
    }
  }

  pushDraft(text: string): void {
    const draft = text.trim();
    if (!draft) return;
    const last = this.steps.at(-1);
    if (last?.kind === 'draft') {
      last.text = `${last.text}\n\n${draft}`;
    } else {
      this.steps.push({ kind: 'draft', text: draft });
    }
  }

  startTool(toolName: string, argsPreview?: string): void {
    this.steps.push({
      kind: 'tool',
      toolName,
      status: 'running',
      ...(argsPreview ? { argsPreview } : {}),
    });
  }

  finishTool(
    toolName: string,
    durationMs?: number,
    resultPreview?: string,
  ): void {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const step = this.steps[i];
      if (
        step?.kind === 'tool' &&
        step.status === 'running' &&
        step.toolName === toolName
      ) {
        step.status = 'done';
        if (durationMs !== undefined) step.durationMs = durationMs;
        if (resultPreview) step.resultPreview = resultPreview;
        return;
      }
    }
    this.steps.push({
      kind: 'tool',
      toolName,
      status: 'done',
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(resultPreview ? { resultPreview } : {}),
    });
  }

  isEmpty(): boolean {
    return this.steps.length === 0;
  }

  /** Returns null when no activity occurred, so callers skip persisting. */
  build(elapsedMs?: number): ActivityTrace | null {
    if (this.steps.length === 0) return null;
    // A run can end while a tool is still marked running (no finish event);
    // present it as done in the persisted, terminal trace.
    const steps = this.steps.map((step) =>
      step.kind === 'tool' && step.status === 'running'
        ? { ...step, status: 'done' as const }
        : step,
    );
    return {
      steps,
      ...(typeof elapsedMs === 'number' && elapsedMs >= 0 ? { elapsedMs } : {}),
    };
  }
}

export function serializeActivityTrace(trace: ActivityTrace): string {
  return JSON.stringify(trace);
}

function readString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Defensive parse — tolerates corrupt or partial JSON by dropping bad steps. */
export function parseActivityTrace(
  raw: string | null | undefined,
): ActivityTrace | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const stepsRaw = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(stepsRaw)) return null;

  const steps: ActivityTraceStep[] = [];
  for (const entry of stepsRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const source = entry as Record<string, unknown>;
    if (source.kind === 'thinking') {
      const text = source.text;
      if (typeof text === 'string') steps.push({ kind: 'thinking', text });
    } else if (source.kind === 'draft') {
      const text = source.text;
      if (typeof text === 'string') steps.push({ kind: 'draft', text });
    } else if (source.kind === 'tool') {
      const toolName = readString(source, 'toolName');
      if (!toolName) continue;
      const step: ActivityTraceToolStep = {
        kind: 'tool',
        toolName,
        status: 'done',
      };
      const argsPreview = readString(source, 'argsPreview');
      if (argsPreview) step.argsPreview = argsPreview;
      const resultPreview = readString(source, 'resultPreview');
      if (resultPreview) step.resultPreview = resultPreview;
      if (typeof source.durationMs === 'number') {
        step.durationMs = source.durationMs;
      }
      steps.push(step);
    }
  }
  if (steps.length === 0) return null;

  const elapsedMs = (parsed as { elapsedMs?: unknown }).elapsedMs;
  return {
    steps,
    ...(typeof elapsedMs === 'number' ? { elapsedMs } : {}),
  };
}
