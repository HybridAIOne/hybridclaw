import { expect, test } from 'vitest';
import {
  detectToolCallLoop,
  recordToolCallOutcome,
  type ToolCallHistoryEntry,
} from '../container/src/tool-loop-detection.js';

const ARGS = JSON.stringify({
  url: 'https://example.com/api/items',
  method: 'POST',
  json: { days: 1 },
});

function response(payload: unknown, date: number, bodyOnly = false): string {
  return JSON.stringify({
    ok: true,
    status: 200,
    headers: { date: String(date) },
    body: JSON.stringify(payload),
    ...(bodyOnly ? {} : { json: payload }),
  });
}

test.each([
  { bodyOnly: false, items: [] },
  { bodyOnly: true, items: [] },
  { bodyOnly: false, items: [{ id: 'item_a' }] },
  { bodyOnly: true, items: [{ id: 'item_a' }] },
])(
  'guards unchanged collections across changing headers and waits: %j',
  ({ bodyOnly, items }) => {
    const history: ToolCallHistoryEntry[] = [];
    for (let i = 0; i < 3; i++) {
      recordToolCallOutcome(
        history,
        'http_request',
        ARGS,
        response({ items, total: items.length }, i, bodyOnly),
        false,
      );
      recordToolCallOutcome(history, 'bash', '{"command":"sleep 2"}', '', false);
    }
    expect(detectToolCallLoop(history, 'http_request', ARGS)).toMatchObject({
      stuck: true,
      detector: 'generic_repeat',
      count: 4,
    });
    const blocked = detectToolCallLoop(history, 'http_request', ARGS);
    if (blocked.stuck) {
      recordToolCallOutcome(history, 'http_request', ARGS, blocked.message, true);
    }
    expect(detectToolCallLoop(history, 'http_request', ARGS).stuck).toBe(true);
    expect(
      detectToolCallLoop(history, 'http_request', ARGS.replace('1', '7')),
    ).toEqual({ stuck: false });
  },
);

test.each([
  { status: 'pending' },
  { items: [], status: 'running' },
  null,
])('does not guard asynchronous status payloads: %j', (payload) => {
  const history: ToolCallHistoryEntry[] = [];
  for (let i = 0; i < 6; i++) {
    recordToolCallOutcome(history, 'http_request', ARGS, response(payload, i), false);
  }
  expect(detectToolCallLoop(history, 'http_request', ARGS)).toEqual({ stuck: false });
});

test('new data and errors break the collection streak', () => {
  const history: ToolCallHistoryEntry[] = [];
  for (let i = 0; i < 3; i++) {
    recordToolCallOutcome(history, 'http_request', ARGS, response([], i), false);
  }
  recordToolCallOutcome(history, 'http_request', ARGS, 'Error: HTTP 503', true);
  expect(detectToolCallLoop(history, 'http_request', ARGS)).toEqual({ stuck: false });
  recordToolCallOutcome(history, 'http_request', ARGS, response([], 4), false);
  expect(detectToolCallLoop(history, 'http_request', ARGS)).toEqual({ stuck: false });
  recordToolCallOutcome(history, 'http_request', ARGS, response([{ id: 'item_a' }], 5), false);
  expect(detectToolCallLoop(history, 'http_request', ARGS)).toEqual({ stuck: false });
});

test('changing records remain progress even when the collection size stays fixed', () => {
  const history: ToolCallHistoryEntry[] = [];
  for (let i = 0; i < 6; i++) {
    recordToolCallOutcome(history, 'http_request', ARGS, response({ items: [{ id: `item_${i}` }], total: 1 }, i), false);
    expect(detectToolCallLoop(history, 'http_request', ARGS)).toEqual({ stuck: false });
  }
});

test.each([{ items: [] }, { items: [{ id: 'item_a' }] }])('a different HTTP operation permits a fresh collection read: %j', ({ items }) => {
  const history: ToolCallHistoryEntry[] = [];
  for (let i = 0; i < 3; i++) {
    recordToolCallOutcome(history, 'http_request', ARGS, response(items, i), false);
  }
  expect(detectToolCallLoop(history, 'http_request', ARGS).stuck).toBe(true);
  recordToolCallOutcome(
    history,
    'http_request',
    JSON.stringify({ url: 'https://example.com/api/requests', method: 'POST' }),
    response({ id: 'request_a' }, 4),
    false,
  );
  expect(detectToolCallLoop(history, 'http_request', ARGS)).toEqual({ stuck: false });
});

test.each([
  'not JSON',
  JSON.stringify({ ok: false, status: 503, json: { items: [] } }),
  JSON.stringify({ ok: true, status: 200, body: 'not JSON' }),
])('does not classify malformed or unsuccessful responses as empty: %s', (output) => {
  const history: ToolCallHistoryEntry[] = [];
  for (let i = 0; i < 4; i++) {
    recordToolCallOutcome(history, 'http_request', ARGS, output, false);
  }
  expect(detectToolCallLoop(history, 'http_request', ARGS)).toEqual({ stuck: false });
});
