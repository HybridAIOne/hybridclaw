import { expect, test } from 'vitest';

import type { ToolApprovalEvaluation } from '../container/src/tool-approval.js';
import {
  formatLineSafeToolProgressText,
  formatToolCallStartProgressText,
  LINE_SAFE_TOOL_PROGRESS_PREFIX,
  TOOL_PROGRESS_PREVIEW_MAX_CHARS,
} from '../container/src/tool-progress-log.js';

function decodeLineSafeProgress(value: string): string {
  expect(value.startsWith(LINE_SAFE_TOOL_PROGRESS_PREFIX)).toBe(true);
  return JSON.parse(
    value.slice(LINE_SAFE_TOOL_PROGRESS_PREFIX.length),
  ) as string;
}

function makeApproval(
  overrides: Partial<ToolApprovalEvaluation> = {},
): ToolApprovalEvaluation {
  return {
    baseTier: 'green',
    tier: 'green',
    autonomyLevel: 'full-autonomous',
    stakes: 'low',
    stakesScore: {
      level: 'low',
      score: 0,
      confidence: 1,
      reasons: ['test'],
      classifier: 'test',
    },
    stakesMiddlewareDecision: { action: 'allow' },
    escalationRoute: 'operator',
    decision: 'auto',
    actionKey: 'read',
    fingerprint: 'fingerprint:test',
    intent: 'run read',
    consequenceIfDenied: 'The tool call will be skipped.',
    reason: 'read-only test action',
    commandPreview: '{"path":"README.md"}',
    pinned: false,
    hostHints: [],
    ...overrides,
  };
}

test('formats multiline tool progress as one line-safe payload', () => {
  const preview = 'line 1\nline 2';

  expect(decodeLineSafeProgress(formatLineSafeToolProgressText(preview))).toBe(
    preview,
  );
});

test('caps large line-safe tool progress payloads', () => {
  const formatted = formatLineSafeToolProgressText(
    'x'.repeat(TOOL_PROGRESS_PREVIEW_MAX_CHARS + 32),
  );
  const preview = decodeLineSafeProgress(formatted);

  expect(preview).toHaveLength(
    TOOL_PROGRESS_PREVIEW_MAX_CHARS + '\n[tool progress truncated]'.length,
  );
  expect(preview.endsWith('\n[tool progress truncated]')).toBe(true);
});

test('logs full green-tier tool-call arguments under the preview cap', () => {
  const argsJson = JSON.stringify({
    action: 'send',
    subject: 'HERE',
    content: 'line 1\nline 2',
  });

  expect(
    decodeLineSafeProgress(
      formatToolCallStartProgressText('message', argsJson, makeApproval()),
    ),
  ).toBe(argsJson);
});

test('masks yellow-tier browser input arguments before logging progress', () => {
  const argsJson = JSON.stringify({ ref: '@e9', text: 'secret password' });
  const approval = makeApproval({
    baseTier: 'yellow',
    tier: 'yellow',
    decision: 'implicit',
    actionKey: 'browser_type',
    intent: 'run browser_type',
    commandPreview: argsJson,
    implicitDelayMs: 5_000,
  });

  const preview = decodeLineSafeProgress(
    formatToolCallStartProgressText('browser_type', argsJson, approval),
  );

  expect(preview).toBe(
    'run browser_type. Waiting 5s for interruption before running.',
  );
  expect(preview).not.toContain('secret password');
});

test('uses yellow-tier web search command previews instead of raw arguments', () => {
  const argsJson = JSON.stringify({
    query: 'private customer account issue',
  });
  const approval = makeApproval({
    baseTier: 'yellow',
    tier: 'yellow',
    decision: 'implicit',
    actionKey: 'web_search',
    intent: 'run web_search',
    commandPreview: 'search the web for project documentation',
  });

  expect(
    decodeLineSafeProgress(
      formatToolCallStartProgressText('web_search', argsJson, approval),
    ),
  ).toBe('search the web for project documentation');
});
