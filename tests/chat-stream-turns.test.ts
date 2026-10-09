import { EventEmitter } from 'node:events';
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatStreamTurn,
  openChatStreamTurn,
  rejoinChatStreamTurn,
} from '../src/gateway/chat-stream-turns.js';

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  writableEnded = false;
  destroyed = false;

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }

  /** The client went away: Node marks the response destroyed, then closes it. */
  drop(): void {
    this.destroyed = true;
    this.emit('close');
  }

  lines(): Array<Record<string, unknown>> {
    return this.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  types(): unknown[] {
    return this.lines().map((line) => line.type);
  }
}

function open(key: string) {
  const res = new FakeResponse();
  const turn = openChatStreamTurn(res as unknown as ServerResponse, key);
  return { res, turn };
}

describe('chat stream turns', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens with unbuffered headers and an accepted line before any turn output', () => {
    const { res, turn } = open('headers');

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    expect(res.lines()).toEqual([{ type: 'accepted' }]);
    turn?.end();
  });

  it('pings only after 15 s without a line', () => {
    const { res, turn } = open('ping');

    vi.advanceTimersByTime(10_000);
    turn?.send({ type: 'text', delta: 'Hi' });
    vi.advanceTimersByTime(10_000);
    expect(res.types()).toEqual(['accepted', 'text']);

    vi.advanceTimersByTime(5_000);
    expect(res.types()).toEqual(['accepted', 'text', 'ping']);

    vi.advanceTimersByTime(15_000);
    expect(res.types()).toEqual(['accepted', 'text', 'ping', 'ping']);

    turn?.end();
    vi.advanceTimersByTime(60_000);
    expect(res.types()).toEqual(['accepted', 'text', 'ping', 'ping']);
    expect(res.writableEnded).toBe(true);
  });

  it('keeps a turn running after its connection drops and replays it to a resend', () => {
    const first = open('resend');
    first.turn?.send({ type: 'text', delta: 'Working' });
    first.res.drop();
    first.turn?.send({ type: 'tool', toolName: 'web_search', phase: 'start' });

    const resend = open('resend');
    expect(resend.turn).toBeNull();
    expect(resend.res.types()).toEqual(['accepted', 'text', 'tool']);

    first.turn?.send({ type: 'result', result: { status: 'success' } });
    first.turn?.end();

    expect(resend.res.types()).toEqual(['accepted', 'text', 'tool', 'result']);
    expect(resend.res.writableEnded).toBe(true);
    expect(first.res.types()).toEqual(['accepted', 'text']);
    expect(first.res.writableEnded).toBe(false);
  });

  it('rejoins a running turn without ever starting one', () => {
    const first = open('rejoin');
    first.turn?.send({ type: 'text', delta: 'Working' });
    first.res.drop();

    const back = new FakeResponse();
    expect(
      rejoinChatStreamTurn(back as unknown as ServerResponse, 'rejoin'),
    ).toBe(true);
    expect(back.types()).toEqual(['accepted', 'text']);
    first.turn?.send({ type: 'result', result: { status: 'success' } });
    first.turn?.end();
    expect(back.types()).toEqual(['accepted', 'text', 'result']);
    expect(back.writableEnded).toBe(true);

    // Ended: nothing to join, and the response is the caller's to answer.
    const late = new FakeResponse();
    expect(
      rejoinChatStreamTurn(late as unknown as ServerResponse, 'rejoin'),
    ).toBe(false);
    expect(late.statusCode).toBe(0);
    expect(late.body).toBe('');
  });

  it('streams live lines to every connection of the turn', () => {
    const first = open('shared');
    const second = open('shared');

    first.turn?.send({ type: 'text', delta: 'Hello' });
    first.turn?.end();

    for (const { res } of [first, second]) {
      expect(res.types()).toEqual(['accepted', 'text']);
      expect(res.writableEnded).toBe(true);
    }
  });

  it.each([
    ['a different request', 'other'],
    ['the same request after the turn ended', 'ended'],
  ])('starts a new turn for %s', (_label, key) => {
    const first = open('ended');
    first.turn?.send({ type: 'text', delta: 'Done' });
    first.turn?.end();

    const next = open(key);
    expect(next.turn).not.toBeNull();
    expect(next.res.types()).toEqual(['accepted']);

    first.turn?.send({ type: 'text', delta: 'late' });
    expect(next.res.types()).toEqual(['accepted']);
    next.turn?.end();
  });
});

describe('chat stream turns on a real socket', () => {
  it('hands the opening lines to the socket before the turn yields', async () => {
    const sockets: Array<{ corked?: number; buffered?: number }> = [];
    const turns: ChatStreamTurn[] = [];
    let handled = () => {};
    const server = http.createServer(async (req, res) => {
      // As in the gateway: awaiting the body makes the rest of the handler a
      // microtask, and Node runs `process.nextTick` callbacks only after the
      // microtask queue drains.
      await text(req);
      const turn = openChatStreamTurn(res, 'real-socket');
      // Stand-in for the context build: synchronous work chained through
      // resolved awaits.
      for (let step = 0; step < 5; step += 1) await Promise.resolve();
      sockets.push({
        corked: res.socket?.writableCorked,
        buffered: res.socket?.writableLength,
      });
      if (turn) {
        turns.push(turn);
        turn.send({ type: 'text', delta: 'Working' });
      }
      handled();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const request = async () => {
      const wasHandled = new Promise<void>((resolve) => {
        handled = resolve;
      });
      const body = fetch(url, { method: 'POST', body: '{}' }).then(
        (response) => response.text(),
      );
      await wasHandled;
      return { body };
    };

    try {
      const first = await request();
      const resend = await request();
      for (const turn of turns) turn.end();

      // Uncorked, and nothing left in the socket's write buffer: the lines
      // went to the kernel before the handler's synchronous work ended.
      expect(sockets).toEqual([
        { corked: 0, buffered: 0 },
        { corked: 0, buffered: 0 },
      ]);
      const types = (body: string) =>
        body
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).type);
      const bodies = await Promise.all([first.body, resend.body]);
      expect(bodies.map(types)).toEqual([
        ['accepted', 'text'],
        ['accepted', 'text'],
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
