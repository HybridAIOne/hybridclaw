import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({
  unstubAllEnvs: true,
  unstubAllGlobals: true,
  resetModules: true,
});

function fixture() {
  const task = tempDir();
  const state = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', task);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', task);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', state);
  vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', JSON.stringify([task, state]));
  return { task, state };
}

test('state and full tool results survive worker replacement outside the task tree', async () => {
  const { task, state } = fixture();
  const { SessionStateSet } = await import('../container/src/session-state.js');
  const seen = new SessionStateSet('seen.json');
  seen.bindSession('session-a');
  seen.add('downloaded-file');
  const { TurnToolHistory } = await import(
    '../container/src/turn-tool-history.js'
  );
  const history = new TurnToolHistory('session-a', state);
  const text = 'Result line\n'.repeat(3000);
  history.recordAssistant({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'tool-a',
        type: 'function',
        function: { name: 'read', arguments: '{}' },
      },
    ],
  });
  history.recordResult({ role: 'tool', tool_call_id: 'tool-a', content: text });
  const output = history.withSpilledReferences({
    status: 'success',
    result: 'done',
    toolsUsed: [],
    toolHistory: history.finish('complete'),
  });
  vi.resetModules();
  const restarted = await import('../container/src/session-state.js');
  const same = new restarted.SessionStateSet('seen.json');
  same.bindSession('session-a');
  const other = new restarted.SessionStateSet('seen.json');
  other.bindSession('session-b');
  expect(same.has('downloaded-file')).toBe(true);
  expect(other.size).toBe(0);
  const { restoreSpilledToolResults } = await import(
    '../src/agent/spilled-tool-results.js'
  );
  expect(
    restoreSpilledToolResults(output, {
      sessionId: 'session-a',
      workspaceRoot: state,
    }).toolHistory?.[1].content,
  ).toBe(text);
  expect(fs.readdirSync(task)).toEqual([]);
});

test('PDF reads and dispatch replay use agent-owned snapshots and default skills', async () => {
  const { task, state } = fixture();
  fs.symlinkSync(path.resolve('skills'), path.join(state, 'skills'));
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]).drawText('Document text');
  const file = path.join(task, 'document.pdf');
  fs.writeFileSync(file, await pdf.save());
  const { readPdfFile } = await import('../container/src/pdf-read.js');
  const result = await readPdfFile(file, {});
  expect(result.visualAttachments).toHaveLength(1);
  expect(fs.readdirSync(task)).toEqual(['document.pdf']);
  expect(fs.readdirSync(path.join(state, '.visual-snapshots'))).toHaveLength(1);
  vi.resetModules();
  const { setVisualMediaAllowed } = await import(
    '../container/src/providers/visual-content.js'
  );
  setVisualMediaAllowed(true);
  const { callRoutedModel } = await import(
    '../container/src/providers/router.js'
  );
  const fetchMock = vi.fn(async (_url, init) => {
    expect(String(init.body)).toContain('image_url');
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: 'assistant', content: 'Read' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  await callRoutedModel({
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    chatbotId: '',
    model: 'test-model',
    messages: [
      {
        role: 'user',
        content: result.output,
        visualAttachments: result.visualAttachments,
      },
    ],
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('separate state keeps policy and pending approvals protected without broadening the task fence', async () => {
  const { task, state } = fixture();
  const { TrustedAgentApprovalRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const runtime = new TrustedAgentApprovalRuntime();
  runtime.setSession('session-a');
  runtime.setApprovalMode({ mode: 'full' });
  const classify = (command: string) =>
    runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command }),
      latestUserPrompt: 'Prepare the task outputs',
    });
  expect(
    classify(`printf value > ${path.join(task, 'result.txt')}`).decision,
  ).toBe('approved_fullauto');
  expect(
    classify(`printf value > ${path.join(state, '.hybridclaw/policy.yaml')}`)
      .decision,
  ).toBe('required');
  expect(classify('printf value > /opt/foreign-output.txt').decision).toBe(
    'required',
  );
  for (const toolName of ['write', 'edit', 'delete']) {
    runtime.setSession(`state-${toolName}`);
    expect(
      runtime.evaluateToolCall({
        toolName,
        argsJson: JSON.stringify({
          path: path.join(state, '.hybridclaw/policy.yaml'),
          contents: 'changed',
        }),
        latestUserPrompt: 'Prepare the task outputs',
      }).decision,
    ).toBe('required');
  }
  runtime.setSession('session-a');
  expect(
    fs.existsSync(path.join(state, '.hybridclaw/pending-approvals.json')),
  ).toBe(true);
  expect(fs.readdirSync(task)).toEqual([]);
  vi.resetModules();
  const { TrustedAgentApprovalRuntime: Restarted } = await import(
    '../container/src/approval-policy.js'
  );
  const restarted = new Restarted();
  restarted.setSession('session-a');
  expect(restarted.getPendingApprovals().length).toBeGreaterThan(0);
});

test('workers without a separate state root retain the mounted workspace default', async () => {
  const { task } = fixture();
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', '');
  const { WORKSPACE_STATE_ROOT } = await import(
    '../container/src/runtime-paths.js'
  );
  expect(WORKSPACE_STATE_ROOT).toBe(task);
});
