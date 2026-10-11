import { expect, test } from 'vitest';
import {
  memoryFlushExcerpts,
  verifiedMemoryFlush,
} from '../src/session/memory-flush.js';
import type { ContainerOutput } from '../src/types/container.js';
import type { ToolExecution } from '../src/types/execution.js';
import type { StoredMessage } from '../src/types/session.js';

function message(role: string, content: string): StoredMessage {
  return {
    id: 1,
    session_id: 'test',
    user_id: 'user',
    username: null,
    role,
    content,
    created_at: '2026-01-01',
  };
}
const failure =
  '[This turn ended with an error before a reply was produced: Provider API error 429]';
const note = 'memory/2026-01-01.md';
function append(content = 'Prefer primary sources.'): ToolExecution {
  return {
    name: 'memory',
    arguments: JSON.stringify({ action: 'append', file_path: note, content }),
    result: `Appended ${content.length} chars to ${note}`,
    durationMs: 1,
  };
}
function output(
  tools: ToolExecution[] = [],
  result = 'Saved.',
): ContainerOutput {
  return {
    status: 'success',
    result,
    toolsUsed: tools.map((tool) => tool.name),
    toolExecutions: tools,
  };
}

test('retry-heavy histories retain one complete profile and the later successful reply', () => {
  const profile = `Selection profile:\n${'Choose technical history and archives.\n'.repeat(80)}Required output: title, date, source and link.`;
  const history = Array.from({ length: 100 }, () => [
    message('user', profile),
    message('assistant', failure),
  ]).flat();
  history.push(message('assistant', 'Completed research.'));
  const excerpts = memoryFlushExcerpts(history, 4, 8000);
  expect(excerpts).toHaveLength(1);
  expect(excerpts[0]).toContain(profile);
  expect(excerpts[0].split(profile)).toHaveLength(2);
  expect(excerpts[0]).toContain('Completed research.');
  expect(excerpts[0]).not.toContain('429');
});

test('complete distinct messages survive both excerpt budgets in chronological order', () => {
  const records = ['first', 'second', 'third', 'fourth'].map((text) =>
    message('user', text),
  );
  const excerpts = memoryFlushExcerpts(records, 2, 30);
  expect(
    excerpts.every(
      (text) => text.length <= 30 && text.split('[USER]').length <= 3,
    ),
  ).toBe(true);
  expect(excerpts.join('\n\n')).toBe(
    records.map((record) => `[USER] ${record.content}`).join('\n\n'),
  );
});

test('oversized instructions retain every character across batches', () => {
  const profile = 'Preferences: ' + 'x'.repeat(300) + '\nRequired ending.';
  const excerpts = memoryFlushExcerpts([message('user', profile)], 2, 80);
  expect(excerpts.every((text) => text.length <= 80)).toBe(true);
  expect(excerpts.join('')).toBe(`[USER] ${profile}`);
});

test('failed turns retain tool effects and successful repeated instructions stay in history', () => {
  const excerpts = memoryFlushExcerpts(
    [
      message('user', 'Weekly brief.'),
      message(
        'assistant',
        `${failure}\nTool calls that already ran:\n- memory: completed`,
      ),
      message('user', 'Weekly brief.'),
      message('assistant', failure),
      message('user', 'Weekly brief.'),
      message('assistant', 'Done.'),
    ],
    80,
    8000,
  );
  expect(excerpts[0]).toContain('- memory: completed');
  expect(excerpts[0].split('Weekly brief.')).toHaveLength(3);
  expect(excerpts[0]).toContain('Done.');
});

test('a successful append requires its new content on disk', () => {
  const tool = append();
  expect(
    verifiedMemoryFlush(
      output([tool]),
      note,
      'Existing.\n',
      'Existing.\n\nPrefer primary sources.\n',
    ),
  ).toBe(true);
});

test.each([
  ['claim without a tool', output(), '', ''],
  ['tool result without a write', output([append()]), '', ''],
  [
    'old content only',
    output([append()]),
    'Prefer primary sources.\n',
    'Prefer primary sources.\n\nUnrelated.\n',
  ],
  ['unrelated disk change', output([append()]), '', 'Unrelated.\n'],
  [
    'failed tool',
    output([{ ...append(), isError: true }]),
    '',
    'Prefer primary sources.\n',
  ],
  [
    'blocked tool',
    output([{ ...append(), blocked: true }]),
    '',
    'Prefer primary sources.\n',
  ],
  [
    'wrong note',
    output([{ ...append(), result: 'Appended 23 chars to MEMORY.md' }]),
    '',
    'Prefer primary sources.\n',
  ],
  [
    'malformed arguments',
    output([{ ...append(), arguments: '{' }]),
    '',
    'Prefer primary sources.\n',
  ],
  [
    'overwrite',
    output([
      {
        ...append(),
        arguments: JSON.stringify({
          action: 'write',
          content: 'Prefer primary sources.',
        }),
      },
    ]),
    '',
    'Prefer primary sources.\n',
  ],
  [
    'provider failure',
    { ...output([append()]), status: 'error' as const },
    '',
    'Prefer primary sources.\n',
  ],
  [
    'lost prior content',
    output([append()]),
    'Existing.\n',
    'Prefer primary sources.\n',
  ],
  [
    'partial save',
    output([append(), append('Also include reviews.')]),
    '',
    'Prefer primary sources.\n',
  ],
  [
    'failed save plus skip',
    output([{ ...append(), isError: true }], 'MEMORY_FLUSH_SKIPPED'),
    '',
    '',
  ],
])('rejects %s', (_label, result, before, after) => {
  expect(verifiedMemoryFlush(result, note, before, after)).toBe(false);
});

test('an explicit skip with no write is a valid completed flush', () => {
  expect(
    verifiedMemoryFlush(
      output([], 'MEMORY_FLUSH_SKIPPED'),
      note,
      'Existing.\n',
      'Existing.\n',
    ),
  ).toBe(true);
  expect(
    verifiedMemoryFlush(output([], 'Nothing to save.'), note, '', ''),
  ).toBe(false);
});

test('oversized Unicode instructions keep complete code points in every batch', () => {
  const profile = '😀'.repeat(60);
  const excerpts = memoryFlushExcerpts([message('user', profile)], 2, 80);
  expect(excerpts.join('')).toBe(`[USER] ${profile}`);
  for (const excerpt of excerpts) {
    expect(excerpt.isWellFormed()).toBe(true);
  }
});

test('a skip cannot conceal a failed read or a disk change', () => {
  const failedRead = {
    ...append(),
    arguments: JSON.stringify({ action: 'read' }),
    isError: true,
  };
  expect(
    verifiedMemoryFlush(
      output([failedRead], 'MEMORY_FLUSH_SKIPPED'),
      note,
      '',
      '',
    ),
  ).toBe(false);
  expect(
    verifiedMemoryFlush(
      output([], 'MEMORY_FLUSH_SKIPPED'),
      note,
      '',
      'Unexpected write.',
    ),
  ).toBe(false);
});


test('a substring of unrelated new text is not a verified append', () => {
  expect(verifiedMemoryFlush(output([append('primary sources')]), note, '', 'Prefer primary sources for research.\n')).toBe(false);
});
