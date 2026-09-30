import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { toolResultFilePath } from '../container/shared/tool-history.js';
import { restoreSpilledToolResults } from '../src/agent/spilled-tool-results.js';
import { CONTAINER_MAX_OUTPUT_SIZE } from '../src/config/config.js';
import type { ContainerOutput } from '../src/types/container.js';

let root: string;
let workspace: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spilled-tool-results-'));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function save(base: string, toolCallId: string, text: string): void {
  const filePath = path.join(base, toolResultFilePath('session-a', toolCallId));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function spilledOutput(ids: string[]): ContainerOutput {
  const preview = (id: string) => `preview of ${id}`;
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
        content: preview(id),
      })),
    ],
    toolHistoryForReplay: ids.map((id) => ({
      role: 'tool' as const,
      tool_call_id: id,
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

test('restores saved results for the transcript and audit, not for replay', () => {
  save(workspace, 'call-a', 'full result a');
  const output = spilledOutput(['call-a']);

  const restored = restore(output);

  expect(restored.toolExecutions?.map((entry) => entry.result)).toEqual([
    'full result a',
    'small',
  ]);
  expect(restored.toolHistory?.[1].content).toBe('full result a');
  expect(restored.toolHistoryForReplay).toEqual(output.toolHistoryForReplay);
});

test('keeps the preview when a link leads out of the workspace', () => {
  const outside = path.join(root, 'outside');
  save(outside, 'call-dir', 'host secret');
  fs.symlinkSync(
    path.join(outside, '.tool-results'),
    path.join(workspace, '.tool-results'),
  );
  expect(restore(spilledOutput(['call-dir'])).toolHistory?.[1].content).toBe(
    'preview of call-dir',
  );

  fs.rmSync(path.join(workspace, '.tool-results'));
  save(workspace, 'placeholder', '');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'host secret');
  fs.symlinkSync(
    path.join(root, 'secret.txt'),
    path.join(workspace, toolResultFilePath('session-a', 'call-file')),
  );
  expect(restore(spilledOutput(['call-file'])).toolHistory?.[1].content).toBe(
    'preview of call-file',
  );
});

test('keeps previews past the per-turn output limit and for missing files', () => {
  save(workspace, 'call-big', 'x'.repeat(CONTAINER_MAX_OUTPUT_SIZE + 1));
  save(workspace, 'call-small', 'full small result');

  const restored = restore(
    spilledOutput(['call-big', 'call-missing', 'call-small']),
  );

  expect(restored.toolHistory?.slice(1).map((entry) => entry.content)).toEqual([
    'preview of call-big',
    'preview of call-missing',
    'full small result',
  ]);
});
