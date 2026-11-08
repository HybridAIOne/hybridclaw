import { expect, test } from 'vitest';
import {
  detectToolCallLoop,
  recordToolCallOutcome,
  type ToolCallHistoryEntry,
} from '../container/src/tool-loop-detection.js';

const readArgs = JSON.stringify({ path: 'record.txt' });
function repeatedReads(): ToolCallHistoryEntry[] {
  const history: ToolCallHistoryEntry[] = [];
  for (let i = 0; i < 3; i++) {
    recordToolCallOutcome(history, 'read', readArgs, 'before', false, false);
  }
  expect(detectToolCallLoop(history, 'read', readArgs).stuck).toBe(true);
  return history;
}

test.each([false, true])(
  'an executed possible write invalidates prior discovery evidence (error=%s)',
  (isError) => {
    const history = repeatedReads();
    recordToolCallOutcome(history, 'edit', '{}', 'changed', isError, true);
    expect(detectToolCallLoop(history, 'read', readArgs).stuck).toBe(false);
    for (let i = 0; i < 3; i++) {
      recordToolCallOutcome(history, 'read', readArgs, 'after', false, false);
    }
    expect(detectToolCallLoop(history, 'read', readArgs).stuck).toBe(true);
  },
);

test.each([
  ['bash', 'blocked', true],
  ['web_search', 'read-only result', false],
] as const)(
  'a non-mutating %s outcome retains the loop evidence',
  (tool, result, isError) => {
    const history = repeatedReads();
    recordToolCallOutcome(history, tool, '{}', result, isError, false);
    expect(detectToolCallLoop(history, 'read', readArgs).stuck).toBe(true);
  },
);

test.each(['glob', 'grep'])(
  'writes invalidate potentially affected %s results',
  (tool) => {
    const history: ToolCallHistoryEntry[] = [];
    const args = JSON.stringify({ pattern: 'status' });
    for (let i = 0; i < 3; i++) {
      recordToolCallOutcome(history, tool, args, 'before', false, false);
    }
    expect(detectToolCallLoop(history, tool, args).stuck).toBe(true);
    recordToolCallOutcome(history, 'bash', '{}', 'changed', false, true);
    expect(detectToolCallLoop(history, tool, args).stuck).toBe(false);
  },
);

test.each([false, true])(
  'HTTP collection evidence changes only after executed possible writes (changed=%s)',
  (changed) => {
    const history: ToolCallHistoryEntry[] = [];
    const args = JSON.stringify({ url: 'https://example.com/items' });
    for (let i = 0; i < 3; i++)
      recordToolCallOutcome(
        history,
        'http_request',
        args,
        JSON.stringify({ ok: true, json: { items: [] } }),
        false,
        false,
      );
    expect(detectToolCallLoop(history, 'http_request', args).stuck).toBe(true);
    recordToolCallOutcome(
      history,
      'bash',
      '{}',
      changed ? 'State may have changed.' : 'Read-only or blocked.',
      !changed,
      changed,
    );
    expect(detectToolCallLoop(history, 'http_request', args).stuck).toBe(
      !changed,
    );
  },
);
