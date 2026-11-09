import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ToolApprovalEvaluation } from '../container/src/approval-policy.js';
import type { ChatCompletionResponse } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const model = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../container/src/providers/router.js', async (original) => ({
  ...(await original<typeof import('../container/src/providers/router.js')>()),
  callRoutedModel: model.call,
}));
const temporary = useTempDir('file-intent-review-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let workspace: string;
beforeEach(() => {
  workspace = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', workspace);
  model.call.mockReset();
});

function response(
  content = '{"decision":"reject","reason":"Unrelated document"}',
  finish = 'stop',
): ChatCompletionResponse {
  return {
    choices: [
      { message: { role: 'assistant', content }, finish_reason: finish },
    ],
  } as ChatCompletionResponse;
}

async function setup(conflicted = true) {
  const state = await import('../container/src/file-write-conflicts.js');
  if (conflicted) await state.recordFileWriteConflict('session-a', 'report.md');
  const { TrustedAgentApprovalRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const runtime = new TrustedAgentApprovalRuntime(
    ...(['policy.yaml', 'agent.json', 'all.json', 'legacy.json'].map((file) =>
      path.join(workspace, file),
    ) as [string, string, string, string]),
    undefined,
    path.join(workspace, 'pending.json'),
  );
  runtime.setSession('session-a');
  runtime.setApprovalMode({ mode: 'full' });
  const argsJson = JSON.stringify({
    path: 'report.md',
    contents: 'Release notes',
    overwrite: true,
    expected_content: 'Garden notes',
  });
  const evaluation = runtime.evaluateToolCall({ toolName: 'write', argsJson });
  const { reviewFileWriteIntent } = await import(
    '../container/src/file-write-review.js'
  );
  const input = {
    sessionId: 'session-a',
    toolName: 'write',
    argsJson,
    evaluation,
    latestUserPrompt: 'Create release notes in report.md.',
    fallbackContext: {
      provider: 'vllm' as const,
      baseUrl: 'http://example.com/v1',
      apiKey: 'test-key',
      model: 'example/model',
      chatbotId: '',
    },
  };
  return { input, reviewFileWriteIntent, state };
}

test('rejects an unrelated checked write without granting consent or clearing its fence', async () => {
  const { input, reviewFileWriteIntent, state } = await setup();
  model.call.mockResolvedValue(response());
  const result = await reviewFileWriteIntent(input);
  expect(result).toMatchObject({
    decision: 'denied',
    escalationRoute: 'policy_denial',
    pinned: true,
  });
  expect(result.requestId).toBeUndefined();
  expect(state.getFileWriteConflict('session-a', 'report.md')).toBeTruthy();
  expect(model.call).toHaveBeenCalledOnce();
  expect(model.call.mock.calls[0][0]).toMatchObject({
    ...input.fallbackContext,
    tools: [],
  });
  expect(fs.existsSync(path.join(workspace, 'report.md'))).toBe(false);
});

test.each(['write', 'edit'])(
  'allows a reviewed %s without changing the original policy decision',
  async (toolName) => {
    const { input, reviewFileWriteIntent } = await setup();
    model.call.mockResolvedValue(
      response('{"decision":"allow","reason":"Requested update"}'),
    );
    const argsJson =
      toolName === 'edit'
        ? JSON.stringify({
            path: 'report.md',
            old: 'Garden notes',
            new: 'Garden notes\nWatered',
          })
        : input.argsJson;
    expect(await reviewFileWriteIntent({ ...input, toolName, argsJson })).toBe(
      input.evaluation,
    );
    expect(model.call).toHaveBeenCalledOnce();
  },
);

test.each(['required', 'denied', 'approved_once'] as const)(
  'does not replace a %s policy or human decision',
  async (decision) => {
    const { input, reviewFileWriteIntent } = await setup();
    const evaluation: ToolApprovalEvaluation = {
      ...input.evaluation,
      decision,
    };
    expect(await reviewFileWriteIntent({ ...input, evaluation })).toBe(
      evaluation,
    );
    expect(model.call).not.toHaveBeenCalled();
  },
);

test.each(['approved_session', 'approved_agent', 'approved_all'] as const)(
  'general %s tool trust does not authorize unrelated file contents',
  async (decision) => {
    const { input, reviewFileWriteIntent } = await setup();
    model.call.mockResolvedValue(response());
    expect(
      await reviewFileWriteIntent({
        ...input,
        evaluation: { ...input.evaluation, decision },
      }),
    ).toMatchObject({ decision: 'denied' });
    expect(model.call).toHaveBeenCalledOnce();
  },
);

test('reviews the same edit aliases that the execution tool accepts', async () => {
  const { input, reviewFileWriteIntent } = await setup();
  model.call.mockResolvedValue(response());
  await reviewFileWriteIntent({
    ...input,
    toolName: 'edit',
    argsJson: JSON.stringify({
      path: 'report.md',
      old: 7,
      old_text: 'Garden notes',
      new: null,
      new_text: 'Release notes',
    }),
  });
  const request = JSON.parse(model.call.mock.calls[0][0].messages[1].content);
  expect(request).toMatchObject({
    existing_content: 'Garden notes',
    proposed_content: 'Release notes',
  });
});

test.each([
  ['read', { path: 'report.md' }],
  ['write', { path: 'report.md', contents: 'New work' }],
  [
    'write',
    {
      path: 'separate.md',
      contents: 'New work',
      overwrite: true,
      expected_content: 'Existing',
    },
  ],
  ['edit', { path: 'report.md', new: 'New work' }],
])(
  'does not add a review for a nonreplacement or unrelated path: %s',
  async (toolName, args) => {
    const { input, reviewFileWriteIntent } = await setup();
    expect(
      await reviewFileWriteIntent({
        ...input,
        toolName,
        argsJson: JSON.stringify(args),
      }),
    ).toBe(input.evaluation);
    expect(model.call).not.toHaveBeenCalled();
  },
);

test('ordinary checked edits without a conflict keep their existing behavior', async () => {
  const { input, reviewFileWriteIntent } = await setup(false);
  expect(await reviewFileWriteIntent(input)).toBe(input.evaluation);
  expect(model.call).not.toHaveBeenCalled();
});

test.each([
  ['not JSON', 'stop'],
  ['{"decision":"allow"}', 'stop'],
  ['{"decision":"allow","reason":"truncated"}', 'length'],
  ['{"decision":"maybe","reason":"unknown"}', 'stop'],
])(
  'keeps the existing file protected after an invalid verdict',
  async (content, finish) => {
    const { input, reviewFileWriteIntent } = await setup();
    model.call.mockResolvedValue(response(content, finish));
    expect(await reviewFileWriteIntent(input)).toMatchObject({
      decision: 'denied',
    });
    expect(model.call).toHaveBeenCalledOnce();
  },
);

test('a model outage cannot approve a protected mutation', async () => {
  const { input, reviewFileWriteIntent } = await setup();
  model.call.mockRejectedValue(new Error('Provider unavailable'));
  expect(await reviewFileWriteIntent(input)).toMatchObject({
    decision: 'denied',
  });
  expect(model.call).toHaveBeenCalledOnce();
});

test('a worker restart reloads shared conflicts and isolates unrelated sessions', async () => {
  const { state } = await setup();
  state.setFileWriteGuardSession('child', 'session-a');
  expect(state.getFileWriteConflict('child', './report.md')).toBe(
    state.getFileWriteConflict('session-a', 'report.md'),
  );
  vi.resetModules();
  const restarted = await import('../container/src/file-write-conflicts.js');
  restarted.setFileWriteGuardSession('sibling', 'session-a');
  expect(restarted.getFileWriteConflict('sibling', 'report.md')).toBeTruthy();
  expect(restarted.getFileWriteConflict('unrelated', 'report.md')).toBeNull();
});

test('each authenticated input replaces the delegated review request without retaining stale intent', async () => {
  const { state } = await setup();
  state.setFileWriteGuardSession('child', 'parent', 'Original request');
  expect(state.fileWriteReviewPrompt('child', 'Delegated request')).toBe(
    'Original request',
  );
  state.setFileWriteGuardSession('child', 'parent');
  expect(
    state.fileWriteReviewPrompt('child', 'Delegated request'),
  ).toBeUndefined();
  state.setFileWriteGuardSession('parent');
  expect(state.fileWriteReviewPrompt('parent', 'Current request')).toBe(
    'Current request',
  );
});

test('automatic preservation denials allow one replan per canonical file, never a pending human decision', async () => {
  const { input, reviewFileWriteIntent } = await setup();
  model.call.mockResolvedValue(response());
  const denied = await reviewFileWriteIntent(input);
  const { canReplanAfterDenial } = await import(
    '../container/src/tool-denial.js'
  );
  expect(canReplanAfterDenial(denied, [])).toBe(true);
  const completed = [
    {
      name: 'write',
      arguments: input.argsJson,
      result: denied.reason,
      durationMs: 0,
      approvalActionKey: denied.actionKey,
    },
  ];
  expect(canReplanAfterDenial(denied, completed)).toBe(false);
  expect(canReplanAfterDenial({ ...denied, decision: 'required' }, [])).toBe(
    false,
  );
});
