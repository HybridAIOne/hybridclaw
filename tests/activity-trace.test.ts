import { describe, expect, it } from 'vitest';
import {
  ActivityTraceBuilder,
  parseActivityTrace,
  serializeActivityTrace,
} from '../src/types/activity-trace.js';

describe('ActivityTraceBuilder', () => {
  it('merges consecutive thinking deltas and collapses tool start/finish', () => {
    const builder = new ActivityTraceBuilder();
    builder.pushThinking('Weighing ');
    builder.pushThinking('options');
    builder.startTool('exec', 'npm test');
    builder.finishTool('exec', 420, 'ok');

    const trace = builder.build(1200);
    expect(trace).toEqual({
      steps: [
        { kind: 'thinking', text: 'Weighing options' },
        {
          kind: 'tool',
          toolName: 'exec',
          status: 'done',
          argsPreview: 'npm test',
          resultPreview: 'ok',
          durationMs: 420,
        },
      ],
      elapsedMs: 1200,
    });
  });

  it('matches finish to the most recent running call of the same tool', () => {
    const builder = new ActivityTraceBuilder();
    builder.startTool('read', 'a.ts');
    builder.startTool('read', 'b.ts');
    builder.finishTool('read', 10, 'b done');

    // The finish binds to the latest running call (b.ts) — it carries the
    // result and duration. a.ts never got a finish; build() coerces its
    // leftover running state to done but leaves it without a result.
    const trace = builder.build();
    expect(trace?.steps).toEqual([
      { kind: 'tool', toolName: 'read', status: 'done', argsPreview: 'a.ts' },
      {
        kind: 'tool',
        toolName: 'read',
        status: 'done',
        argsPreview: 'b.ts',
        resultPreview: 'b done',
        durationMs: 10,
      },
    ]);
  });

  it('coerces a still-running tool to done in the terminal build', () => {
    const builder = new ActivityTraceBuilder();
    builder.startTool('exec', 'sleep');
    const trace = builder.build();
    expect(trace?.steps).toEqual([
      { kind: 'tool', toolName: 'exec', status: 'done', argsPreview: 'sleep' },
    ]);
  });

  it('returns null for an empty trace and reports isEmpty', () => {
    const builder = new ActivityTraceBuilder();
    expect(builder.isEmpty()).toBe(true);
    expect(builder.build(100)).toBeNull();
    builder.pushThinking('');
    expect(builder.isEmpty()).toBe(true);
  });

  it('omits a negative elapsed and keeps zero', () => {
    const builder = new ActivityTraceBuilder();
    builder.pushThinking('x');
    expect(builder.build(-5)).toEqual({
      steps: [{ kind: 'thinking', text: 'x' }],
    });
    expect(builder.build(0)).toEqual({
      steps: [{ kind: 'thinking', text: 'x' }],
      elapsedMs: 0,
    });
  });
});

describe('serialize/parseActivityTrace round-trip', () => {
  it('round-trips a built trace', () => {
    const builder = new ActivityTraceBuilder();
    builder.pushThinking('think');
    builder.startTool('exec', 'ls');
    builder.finishTool('exec', 5, 'files');
    const trace = builder.build(900);
    if (!trace) throw new Error('expected a trace');

    const parsed = parseActivityTrace(serializeActivityTrace(trace));
    expect(parsed).toEqual(trace);
  });

  it('returns null for corrupt or non-trace JSON', () => {
    expect(parseActivityTrace(null)).toBeNull();
    expect(parseActivityTrace('')).toBeNull();
    expect(parseActivityTrace('{bad')).toBeNull();
    expect(parseActivityTrace('{"steps":"nope"}')).toBeNull();
    expect(parseActivityTrace('{"steps":[]}')).toBeNull();
  });

  it('drops malformed steps but keeps valid ones', () => {
    const parsed = parseActivityTrace(
      JSON.stringify({
        steps: [
          { kind: 'thinking', text: 'ok' },
          { kind: 'thinking' },
          { kind: 'tool' },
          { kind: 'tool', toolName: 'exec', durationMs: 'nan' },
          { kind: 'mystery' },
        ],
        elapsedMs: 7,
      }),
    );
    expect(parsed).toEqual({
      steps: [
        { kind: 'thinking', text: 'ok' },
        { kind: 'tool', toolName: 'exec', status: 'done' },
      ],
      elapsedMs: 7,
    });
  });
});
