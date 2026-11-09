import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import {
  toolResultDigest,
  toolResultFilePath,
  toolResultForTransport,
} from '../container/shared/tool-history.js';
import { restoreSpilledToolResults } from '../src/agent/spilled-tool-results.js';
import { CONTAINER_MAX_OUTPUT_SIZE } from '../src/config/config.js';
import type { ContainerOutput } from '../src/types/container.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('spilled-tool-results-');
const digests = new Map<string, string>();
const digest = (id: string) =>
  digests.get(id) ?? toolResultDigest(`missing ${id}`);
const relative = (id: string) =>
  toolResultFilePath('session-a', id, digest(id));
const preview = (id: string) =>
  toolResultForTransport({ role: 'tool', content: '' }, relative(id)).content;
let root: string;
let workspace: string;

beforeEach(() => {
  root = temp();
  digests.clear();
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
});

function save(base: string, toolCallId: string, text: string): void {
  digests.set(toolCallId, toolResultDigest(text));
  const filePath = path.join(base, relative(toolCallId));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function spilledOutput(ids: string[]): ContainerOutput {
  return {
    status: 'success',
    result: 'Done',
    toolsUsed: ['read'],
    toolExecutions: [
      ...ids.map((id) => ({
        name: 'read',
        arguments: '{}',
        result: preview(id),
        toolCallId: id,
        resultDigest: digest(id),
        durationMs: 1,
      })),
      { name: 'read', arguments: '{}', result: 'small', durationMs: 1 },
    ],
    toolHistory: [
      {
        role: 'assistant',
        content: null,
        tool_calls: ids.map((id) => ({
          id,
          type: 'function' as const,
          function: { name: 'read', arguments: '{}' },
        })),
      },
      ...ids.map((id) => ({
        role: 'tool' as const,
        tool_call_id: id,
        resultDigest: digest(id),
        content: preview(id),
      })),
    ],
    toolHistoryForReplay: ids.map((id) => ({
      role: 'tool' as const,
      tool_call_id: id,
      resultDigest: digest(id),
      content: preview(id),
    })),
    spilledToolCallIds: ids,
  };
}

function restore(output: ContainerOutput): ContainerOutput {
  return restoreSpilledToolResults(output, {
    sessionId: 'session-a',
    workspaceRoot: workspace,
  });
}

test('restores saved results for transcript, audit and model replay', () => {
  save(workspace, 'call-a', 'full result a');
  const output = spilledOutput(['call-a']);

  const restored = restore(output);

  expect(restored.toolExecutions?.map((entry) => entry.result)).toEqual([
    'full result a',
    'small',
  ]);
  expect(restored.toolHistory?.[1].content).toBe('full result a');
  expect(restored.toolHistoryForReplay?.[0].content).toBe('full result a');
});

test('keeps explicit references when bytes no longer match their recorded digest', () => {
  save(workspace, 'call-a', 'original recorded bytes');
  const output = spilledOutput(['call-a']);
  fs.writeFileSync(path.join(workspace, relative('call-a')), 'changed bytes');
  expect(restore(output)).toEqual(output);
});

test('a call-ID manifest without a per-result digest cannot select saved bytes', () => {
  save(workspace, 'call-a', 'recorded bytes');
  const output = spilledOutput(['call-a']);
  for (const execution of output.toolExecutions || [])
    delete execution.resultDigest;
  for (const message of [
    ...(output.toolHistory || []),
    ...(output.toolHistoryForReplay || []),
  ])
    delete message.resultDigest;
  expect(restore(output)).toEqual(output);
});

test('keeps the preview when a link leads out of the workspace', () => {
  const outside = path.join(root, 'outside');
  save(outside, 'call-dir', 'host secret');
  fs.symlinkSync(
    path.join(outside, '.tool-results'),
    path.join(workspace, '.tool-results'),
  );
  expect(restore(spilledOutput(['call-dir'])).toolHistory?.[1].content).toBe(
    preview('call-dir'),
  );

  fs.rmSync(path.join(workspace, '.tool-results'));
  save(workspace, 'placeholder', '');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'host secret');
  digests.set('call-file', toolResultDigest('host secret'));
  fs.symlinkSync(
    path.join(root, 'secret.txt'),
    path.join(workspace, relative('call-file')),
  );
  expect(restore(spilledOutput(['call-file'])).toolHistory?.[1].content).toBe(
    preview('call-file'),
  );
});

test('keeps previews past the per-turn output limit and for missing files', () => {
  save(workspace, 'call-big', 'x'.repeat(CONTAINER_MAX_OUTPUT_SIZE + 1));
  save(workspace, 'call-small', 'full small result');

  const restored = restore(
    spilledOutput(['call-big', 'call-missing', 'call-small']),
  );

  expect(restored.toolHistory?.slice(1).map((entry) => entry.content)).toEqual([
    preview('call-big'),
    preview('call-missing'),
    'full small result',
  ]);
});

test('charges each distinct saved result once against the cumulative limit', () => {
  const first = 'a'.repeat(Math.floor(CONTAINER_MAX_OUTPUT_SIZE * 0.6));
  const second = 'b'.repeat(Math.floor(CONTAINER_MAX_OUTPUT_SIZE * 0.6));
  const third = 'c'.repeat(Math.floor(CONTAINER_MAX_OUTPUT_SIZE * 0.3));
  save(workspace, 'call-a', first);
  save(workspace, 'call-b', second);
  save(workspace, 'call-c', third);

  const restored = restore(spilledOutput(['call-a', 'call-b', 'call-c']));
  const expected = [first, preview('call-b'), third];
  expect(restored.toolHistory?.slice(1).map((entry) => entry.content)).toEqual(
    expected,
  );
  expect(
    restored.toolExecutions?.slice(0, 3).map((entry) => entry.result),
  ).toEqual(expected);
  expect(restored.toolHistoryForReplay?.map((entry) => entry.content)).toEqual(
    expected,
  );
});

test('preserves whole-context compaction when restoring replay', () => {
  save(workspace, 'call-a', 'full result a');
  const output = spilledOutput(['call-a']);
  output.toolHistoryForReplay![0].content = '[Historical result compacted]';
  expect(restore(output).toolHistoryForReplay).toEqual(
    output.toolHistoryForReplay,
  );
});
