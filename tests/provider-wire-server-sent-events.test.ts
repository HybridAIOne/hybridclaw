import {
  readServerSentEvents,
  type ServerSentEvent,
} from '@hybridclaw/shared/provider-wire/server-sent-events';
import { describe, expect, it } from 'vitest';

async function collect(chunks: string[]): Promise<ServerSentEvent[]> {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) => encoder.encode(chunk));
  const events: ServerSentEvent[] = [];
  for await (const event of readServerSentEvents(async () => {
    const value = queue.shift();
    return value ? { done: false, value } : { done: true };
  })) {
    events.push(event);
  }
  return events;
}

describe('readServerSentEvents', () => {
  it.each([
    ['one event', ['data: {"a":1}\n\n'], [{ event: null, data: '{"a":1}' }]],
    [
      'multi-line data joined with newlines',
      ['data: first\ndata: second\n\n'],
      [{ event: null, data: 'first\nsecond' }],
    ],
    [
      'only one leading space stripped',
      ['data:  indented\ndata:tight\n\n'],
      [{ event: null, data: ' indented\ntight' }],
    ],
    [
      'CRLF line endings',
      ['event: delta\r\ndata: x\r\n\r\n'],
      [{ event: 'delta', data: 'x' }],
    ],
    [
      'comments, ids, and data-less events skipped',
      [': keep-alive\n\nid: 7\nretry: 10\n\nevent: ping\n\ndata: y\n\n'],
      [{ event: null, data: 'y' }],
    ],
    [
      'events split across chunks',
      ['da', 'ta: sp', 'lit\n', '\ndata: next\n\n'],
      [
        { event: null, data: 'split' },
        { event: null, data: 'next' },
      ],
    ],
    [
      'a final event without its blank line',
      ['data: a\n\ndata: tail'],
      [
        { event: null, data: 'a' },
        { event: null, data: 'tail' },
      ],
    ],
    ['an empty data field', ['data:\n\n'], [{ event: null, data: '' }]],
  ])('decodes %s', async (_label, chunks, expected) => {
    expect(await collect(chunks)).toEqual(expected);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: héllo\n\n');
    const parts = [bytes.slice(0, 8), bytes.slice(8)];
    const events: ServerSentEvent[] = [];
    for await (const event of readServerSentEvents(async () => {
      const value = parts.shift();
      return value ? { done: false, value } : { done: true };
    })) {
      events.push(event);
    }
    expect(events).toEqual([{ event: null, data: 'héllo' }]);
  });
});
