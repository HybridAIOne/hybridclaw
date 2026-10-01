import { expect, test } from 'vitest';

import {
  parseBrowserFrameLine,
  parseToolProgressLine,
} from '../src/infra/tool-progress-parser.js';

test('parses plain tool start and result progress lines', () => {
  expect(parseToolProgressLine('[tool] read: {"path":"README.md"}')).toEqual({
    toolName: 'read',
    phase: 'start',
    preview: '{"path":"README.md"}',
  });
  expect(parseToolProgressLine('[tool] read result (12ms): ok')).toEqual({
    toolName: 'read',
    phase: 'finish',
    durationMs: 12,
    preview: 'ok',
  });
});

test('parses complete line-safe tool progress payloads', () => {
  const args = JSON.stringify({
    action: 'send',
    subject: 'HERE',
    content: 'line 1\nline 2',
  });
  expect(
    parseToolProgressLine(`[tool] message: json:${JSON.stringify(args)}`),
  ).toEqual({
    toolName: 'message',
    phase: 'start',
    preview: args,
  });

  const result = JSON.stringify(
    {
      ok: true,
      action: 'send',
      nested: { status: 'queued' },
    },
    null,
    2,
  );
  expect(
    parseToolProgressLine(
      `[tool] message result (1332ms): json:${JSON.stringify(result)}`,
    ),
  ).toEqual({
    toolName: 'message',
    phase: 'finish',
    durationMs: 1332,
    preview: result,
  });
});

test('parses labelled browser tool progress lines using the canonical tool name', () => {
  expect(
    parseToolProgressLine(
      '[tool] browser_snapshot [browser=mac-cua]: run browser_snapshot',
    ),
  ).toEqual({
    toolName: 'browser_snapshot',
    phase: 'start',
    preview: 'run browser_snapshot',
  });
  expect(
    parseToolProgressLine(
      '[tool] browser_snapshot [browser=mac-cua] result (123ms): snapshot ok',
    ),
  ).toEqual({
    toolName: 'browser_snapshot',
    phase: 'finish',
    durationMs: 123,
    preview: 'snapshot ok',
  });
});

test('ignores non-tool progress lines', () => {
  expect(
    parseToolProgressLine('[tool] running 2 tool calls concurrently'),
  ).toBeNull();
  expect(parseToolProgressLine('[thinking] checking')).toBeNull();
});

test('parses browser frame lines and ignores everything else', () => {
  expect(
    parseBrowserFrameLine(
      '[browser-frame] {"url":"https://shop.example/cart","title":"Cart","frame":".browser-artifacts/frames/a.jpg"}',
    ),
  ).toEqual({
    url: 'https://shop.example/cart',
    title: 'Cart',
    frame: '.browser-artifacts/frames/a.jpg',
  });
  expect(
    parseBrowserFrameLine(
      '[browser-frame] {"url":"https://shop.example/pay","title":"Pay"}',
    ),
  ).toEqual({ url: 'https://shop.example/pay', title: 'Pay' });
  expect(
    parseBrowserFrameLine(
      '[browser-frame] {"url":"https://hybridai.one/login","title":"Login","signIn":{"host":"HybridAI.one"}}',
    ),
  ).toEqual({
    url: 'https://hybridai.one/login',
    title: 'Login',
    signIn: { host: 'hybridai.one' },
  });
  expect(
    parseBrowserFrameLine(
      '[browser-frame] {"url":"https://hybridai.one/login","title":"Login","signIn":{"host":"evil.example/path"}}',
    ),
  ).toEqual({ url: 'https://hybridai.one/login', title: 'Login' });
  expect(parseBrowserFrameLine('[browser-frame] {"title":"no url"}')).toBeNull();
  expect(parseBrowserFrameLine('[browser-frame] not json')).toBeNull();
  expect(parseBrowserFrameLine('[tool] browser_click: {}')).toBeNull();
});
