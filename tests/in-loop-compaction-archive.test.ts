import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const runtime = { workspace: '' };

useCleanMocks({ resetModules: true, unstubAllEnvs: true });
const makeTempDir = useTempDir();
beforeEach(() => {
  runtime.workspace = makeTempDir('hc-compaction-archive-');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', runtime.workspace);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', '');
});

describe('createInLoopCompactionArchive', () => {
  test('separate state archives remain readable through their returned reference', async () => {
    const state = makeTempDir('hc-compaction-state-');
    vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', state);
    vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', JSON.stringify([state]));
    const { createInLoopCompactionArchive } = await import(
      '../container/src/in-loop-compaction-archive.js'
    );
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Archived context evidence.' },
    ];
    const archive = createInLoopCompactionArchive('session_a');
    archive.write(messages);
    expect(path.isAbsolute(archive.path)).toBe(true);
    expect(path.relative(state, archive.path).startsWith('..')).toBe(false);
    expect(fs.readdirSync(runtime.workspace)).toEqual([]);
    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'read',
      JSON.stringify({ path: archive.path }),
    );
    expect(result).toContain('Archived context evidence.');
    vi.resetModules();
    expect(JSON.parse(fs.readFileSync(archive.path, 'utf8')).messages).toEqual(
      messages,
    );
  });

  test('keeps complete structured messages in separate private, persistent files', async () => {
    const { createInLoopCompactionArchive } = await import(
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
    const firstArchive = createInLoopCompactionArchive('../user_a/session');
    const secondArchive = createInLoopCompactionArchive('../user_a/session');
    firstArchive.write(messages);
    secondArchive.write(messages);
    const first = firstArchive.path;
    const second = secondArchive.path;

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
    reloaded.createInLoopCompactionArchive('../user_a/session').write([]);
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
    const { createInLoopCompactionArchive } = await import(
      '../container/src/in-loop-compaction-archive.js'
    );

    expect(() =>
      createInLoopCompactionArchive('session_a').write([]),
    ).toThrow();
  });
  test('does not create a file when archive framing makes a replacement too large', async () => {
    const { createInLoopCompactionArchive } = await import(
      '../container/src/in-loop-compaction-archive.js'
    );
    const { compactInLoop } = await import(
      '../container/src/in-loop-compaction.js'
    );
    const archive = createInLoopCompactionArchive('session_a');
    const history: ChatMessage[] = Array.from({ length: 13 }, () => ({
      role: 'assistant',
      content: 'Original '.repeat(10),
    }));
    const result = await compactInLoop({
      history,
      archive,
      summarize: async () => ({
        id: 'test',
        model: 'test-model',
        choices: [
          {
            message: { role: 'assistant', content: 'Summary' },
            finish_reason: 'stop',
          },
        ],
      }),
    });
    expect(result.changed).toBe(false);
    expect(result.history).toBe(history);
    expect(fs.existsSync(path.join(runtime.workspace, archive.path))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(runtime.workspace, '.hybridclaw-runtime')),
    ).toBe(false);
  });
});
