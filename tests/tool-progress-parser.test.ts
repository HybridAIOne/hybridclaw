import { expect, test } from 'vitest';

import { parseToolProgressLine } from '../src/infra/tool-progress-parser.js';

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
