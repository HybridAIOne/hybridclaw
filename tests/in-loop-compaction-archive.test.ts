import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const runtime = vi.hoisted(() => ({ workspace: '' }));
vi.mock('../container/src/runtime-paths.js', () => ({
  get WORKSPACE_ROOT() {
    return runtime.workspace;
  },
}));

useCleanMocks({ resetModules: true });
const makeTempDir = useTempDir();
beforeEach(() => {
  runtime.workspace = makeTempDir('hc-compaction-archive-');
});

describe('archiveInLoopCompaction', () => {
  test('keeps complete structured messages in separate private, persistent files', async () => {
    const { archiveInLoopCompaction } = await import(
      '../container/src/in-loop-compaction-archive.js'
    );
    const messages: ChatMessage[] = [
      { role: 'user', content: 'detail '.repeat(6_000) },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"example.txt"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_a',
        content: 'result '.repeat(6_000),
        is_error: true,
      },
    ];
    const first = archiveInLoopCompaction('../user_a/session', messages);
    const second = archiveInLoopCompaction('../user_a/session', messages);

    expect(first).not.toBe(second);
    expect(first).toMatch(
      /^\.hybridclaw-runtime\/sessions\/[a-f0-9]{32}\/in-loop-compactions\/[a-f0-9-]+\.json$/,
    );
    for (const relative of [first, second]) {
      const absolute = path.join(runtime.workspace, relative);
      expect(JSON.parse(fs.readFileSync(absolute, 'utf8'))).toEqual({
        version: 1,
        messages,
      });
      expect(fs.statSync(absolute).mode & 0o777).toBe(0o600);
    }
    vi.resetModules();
    const reloaded = await import(
      '../container/src/in-loop-compaction-archive.js'
    );
    reloaded.archiveInLoopCompaction('../user_a/session', []);
    expect(
      JSON.parse(fs.readFileSync(path.join(runtime.workspace, first), 'utf8'))
        .messages,
    ).toEqual(messages);
  });

  test('propagates persistence failures so compaction cannot erase originals', async () => {
    fs.writeFileSync(
      path.join(runtime.workspace, '.hybridclaw-runtime'),
      'blocked',
    );
    const { archiveInLoopCompaction } = await import(
      '../container/src/in-loop-compaction-archive.js'
    );

    expect(() => archiveInLoopCompaction('session_a', [])).toThrow();
  });
});
