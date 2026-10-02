import { describe, expect, test } from 'vitest';
import { isLoopGuardedToolName } from '../container/src/tool-loop-detection.js';
import {
  leadingParallelRun,
  mapConcurrentInOrder,
  takeCachedValue,
} from '../container/src/tool-parallelism.js';
import type { ToolCall } from '../container/src/types.js';

function call(
  id: string,
  name: string,
  args: Record<string, unknown> | string = {},
): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

const READ_ONLY_MCP_TOOLS = new Set(['hybridai__web_search']);
const isReadOnlyMcpTool = (name: string) => READ_ONLY_MCP_TOOLS.has(name);

// Walks a batch the way the tool loop does: a run of two or more calls runs
// concurrently, otherwise the first call runs alone.
function plan(calls: ToolCall[]): string[][] {
  const segments: string[][] = [];
  for (let index = 0; index < calls.length; ) {
    const run = leadingParallelRun(calls.slice(index), isReadOnlyMcpTool);
    const size = run.length > 1 ? run.length : 1;
    segments.push(calls.slice(index, index + size).map((entry) => entry.id));
    index += size;
  }
  return segments;
}

const search = (id: string) => call(id, 'web_search', { query: id });

describe('leadingParallelRun', () => {
  test.each([
    ['bash', { command: 'git status' }],
    ['browser_navigate', { url: 'https://example.com' }],
    ['browser_snapshot', {}],
    ['browser_click', { ref: 'e1' }],
    ['message', { action: 'send', content: 'hi' }],
    ['message', { action: 'read', channelId: '123' }],
    ['memory', { action: 'append', content: 'note' }],
    ['delegate', { prompt: 'check the logs' }],
    ['cron', { action: 'list' }],
    ['http_request', { url: 'https://example.com', method: 'POST' }],
    ['image_generate', { prompt: 'a cat' }],
    ['diagram_create', { format: 'mermaid', source: 'graph TD; A-->B' }],
    ['github__search_issues', { query: 'bug' }],
    ['tool_catalog', { action: 'list', name: '' }],
    ['unknown_tool', {}],
  ])('runs %s alone while the calls around it still batch', (name, args) => {
    const batch = [
      search('a'),
      search('b'),
      call('barrier', name, args),
      search('c'),
      search('d'),
    ];

    expect(plan(batch)).toEqual([['a', 'b'], ['barrier'], ['c', 'd']]);
  });

  test('batches the allowlisted read-only and file tools together', () => {
    const batch = [
      call('1', 'web_search', { query: 'hybridclaw' }),
      call('2', 'web_fetch', { url: 'https://example.com' }),
      call('3', 'web_extract', { url: 'https://example.com/docs' }),
      call('4', 'session_search', { query: 'deploy' }),
      call('5', 'skills_list', {}),
      call('6', 'vision_analyze', { image_url: 'chart.png', question: 'what?' }),
      call('7', 'read', { path: 'src/index.ts' }),
      call('8', 'glob', { pattern: 'src/**/*.ts' }),
      call('9', 'grep', { pattern: 'TODO' }),
      call('10', 'hybridai__web_search', { query: 'ai news' }),
    ];

    expect(plan(batch)).toEqual([batch.map((entry) => entry.id)]);
  });

  test.each<[string, ToolCall[], string[][]]>([
    [
      'readers of one file share a run',
      [call('r1', 'read', { path: 'a.txt' }), call('r2', 'read', { path: 'a.txt' })],
      [['r1', 'r2']],
    ],
    [
      'a write after a read of the same file waits for it',
      [call('r', 'read', { path: 'a.txt' }), call('w', 'write', { path: 'a.txt', contents: 'x' })],
      [['r'], ['w']],
    ],
    [
      'a read after a write sees the write, whatever the path spelling',
      [
        call('w', 'write', { path: '/workspace/notes/a.md', contents: 'x' }),
        call('r', 'read', { path: './notes//a.md' }),
      ],
      [['w'], ['r']],
    ],
    [
      'writers of different files share a run',
      [
        call('w', 'write', { path: 'a.txt', contents: 'x' }),
        call('e', 'edit', { path: 'b.txt', old: 'a', new: 'b' }),
        call('d', 'delete', { path: 'c.txt' }),
      ],
      [['w', 'e', 'd']],
    ],
    [
      'a sibling with a common name prefix does not overlap',
      [call('w', 'write', { path: 'src/a', contents: 'x' }), call('r', 'read', { path: 'src/ab' })],
      [['w', 'r']],
    ],
    [
      'a grep covers the files under its path',
      [
        call('e', 'edit', { path: 'src/a.ts', old: 'a', new: 'b' }),
        call('g', 'grep', { pattern: 'b', path: 'src' }),
        call('o', 'grep', { pattern: 'b', path: 'docs' }),
      ],
      [['e'], ['g', 'o']],
    ],
    [
      'a grep without a path covers the workspace',
      [call('w', 'write', { path: 'docs/x.md', contents: 'x' }), call('g', 'grep', { pattern: 'x' })],
      [['w'], ['g']],
    ],
    [
      'a glob covers the directory before its first wildcard segment',
      [
        call('w', 'write', { path: 'src/abc.ts', contents: 'x' }),
        call('g1', 'glob', { pattern: 'src/a*.ts' }),
        call('g2', 'glob', { pattern: 'docs/**/*.md' }),
      ],
      [['w'], ['g1', 'g2']],
    ],
    [
      'a conflict starts a new run',
      [
        call('r1', 'read', { path: 'a.txt' }),
        call('r2', 'read', { path: 'b.txt' }),
        call('w', 'write', { path: 'a.txt', contents: 'x' }),
        call('r3', 'read', { path: 'c.txt' }),
      ],
      [['r1', 'r2'], ['w', 'r3']],
    ],
    [
      'tools without a path never conflict with a writer',
      [call('w', 'write', { path: 'a.txt', contents: 'x' }), search('s')],
      [['w', 's']],
    ],
  ])('%s', (_name, batch, expected) => {
    expect(plan(batch)).toEqual(expected);
  });

  test.each([
    ['read', {}],
    ['read', { path: '   ' }],
    ['read', { path: '../outside.txt' }],
    ['write', '{"path":"a.txt","contents":'],
    ['edit', { path: 42 }],
    ['glob', { pattern: '../**/*.ts' }],
    ['grep', { pattern: 'x', path: '../elsewhere' }],
  ])('runs %s alone when its path is unknown: %j', (name, args) => {
    expect(plan([search('a'), search('b'), call('file', name, args)])).toEqual([
      ['a', 'b'],
      ['file'],
    ]);
  });
});

describe('isLoopGuardedToolName', () => {
  test.each([
    'read',
    'glob',
    'grep',
  ])('marks %s as loop-guarded', (toolName) => {
    expect(isLoopGuardedToolName(toolName)).toBe(true);
  });

  test.each([
    'bash',
    'session_search',
    'vision_analyze',
    'message',
    'web_fetch',
  ])('does not mark %s as loop-guarded', (toolName) => {
    expect(isLoopGuardedToolName(toolName)).toBe(false);
  });
});

describe('mapConcurrentInOrder', () => {
  test('returns results in input order', async () => {
    const items = [30, 5, 15, 0];

    const results = await mapConcurrentInOrder(items, async (delayMs) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return `result-${delayMs}`;
    });

    expect(results).toEqual(['result-30', 'result-5', 'result-15', 'result-0']);
  });

  test('handles empty input', async () => {
    await expect(
      mapConcurrentInOrder([], async () => 'unused'),
    ).resolves.toEqual([]);
  });
});

describe('takeCachedValue', () => {
  test('returns and removes a cached value', () => {
    const cache = new Map<string, string>([['call-1', 'cached']]);

    expect(takeCachedValue(cache, 'call-1')).toBe('cached');
    expect(takeCachedValue(cache, 'call-1')).toBeNull();
    expect(cache.size).toBe(0);
  });

  test('returns null when no cached value exists', () => {
    expect(takeCachedValue(new Map<string, string>(), 'missing')).toBeNull();
  });
});
