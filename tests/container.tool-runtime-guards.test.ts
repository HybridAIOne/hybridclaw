import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  detectToolCallLoop,
  recordToolCallOutcome,
} from '../container/src/tool-loop-detection.js';

describe.sequential('container tool runtime guards', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  test('keeps read output with error-like words as a successful tool result', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-tool-guards-'),
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'notes.md'),
      'Formula Error Prevention\ninvalid references are bad examples.\n',
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      'read',
      JSON.stringify({ path: 'notes.md' }),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Formula Error Prevention');
  });

  test('marks explicit tool failures structurally', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-tool-guards-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );
    const result = await executeToolWithMetadata(
      'read',
      JSON.stringify({ path: 'missing.md' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('File not found');
  });

  test('blocks repeated identical discovery calls with identical outcomes', () => {
    const history = [];
    const argsJson = JSON.stringify({ path: 'same.md' });

    for (let i = 0; i < 3; i += 1) {
      recordToolCallOutcome(history, 'read', argsJson, 'same output', false);
    }

    const result = detectToolCallLoop(history, 'read', argsJson);

    expect(result.stuck).toBe(true);
    if (!result.stuck) return;
    expect(result.detector).toBe('generic_repeat');
    expect(result.count).toBe(4);
  });

  test('blocks repeated ping-pong discovery loops with no new information', () => {
    const history = [];
    const readArgs = JSON.stringify({ path: 'a.md' });
    const globArgs = JSON.stringify({ pattern: '*.md' });

    recordToolCallOutcome(history, 'read', readArgs, 'same read', false);
    recordToolCallOutcome(history, 'glob', globArgs, 'same glob', false);
    recordToolCallOutcome(history, 'read', readArgs, 'same read', false);
    recordToolCallOutcome(history, 'glob', globArgs, 'same glob', false);
    recordToolCallOutcome(history, 'read', readArgs, 'same read', false);

    const result = detectToolCallLoop(history, 'glob', globArgs);

    expect(result.stuck).toBe(true);
    if (!result.stuck) return;
    expect(result.detector).toBe('ping_pong');
    expect(result.count).toBe(6);
  });
});
