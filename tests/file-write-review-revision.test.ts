import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ChatCompletionResponse } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const model = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../container/src/providers/router.js', async (original) => ({
  ...(await original<typeof import('../container/src/providers/router.js')>()),
  callRoutedModel: model.call,
}));
const temporary = useTempDir('file-review-revision-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
const original = 'Garden notes\r\nWater weekly.\r\n';
const replacement = 'Release notes\nAdded offline mode.\n';
const revision = (value: string) =>
  createHash('sha256').update(value).digest('hex');
let workspace: string;

beforeEach(() => {
  workspace = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', workspace);
  model.call.mockReset();
});

async function setup() {
  fs.writeFileSync(path.join(workspace, 'report.md'), original);
  fs.writeFileSync(path.join(workspace, 'garden-backup.md'), original);
  const state = await import('../container/src/file-write-conflicts.js');
  await state.recordFileWriteConflict('session-a', 'report.md');
  const { TrustedAgentApprovalRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(workspace, 'policy.yaml'),
  );
  runtime.setSession('session-a');
  runtime.setApprovalMode({ mode: 'full' });
  const args = {
    path: 'report.md',
    contents: replacement,
    overwrite: true,
    expected_sha256: revision(original),
  };
  const argsJson = JSON.stringify(args);
  const evaluation = runtime.evaluateToolCall({ toolName: 'write', argsJson });
  const { reviewFileWriteIntent } = await import(
    '../container/src/file-write-review.js'
  );
  return {
    args,
    state,
    reviewFileWriteIntent,
    input: {
      sessionId: 'session-a',
      toolName: 'write',
      argsJson,
      evaluation,
      latestUserPrompt: 'Create software release notes in report.md.',
      fallbackContext: {
        provider: 'vllm' as const,
        baseUrl: 'http://example.com/v1',
        apiKey: 'test-key',
        model: 'example/model',
        chatbotId: '',
      },
    },
  };
}

function verdict(decision: 'allow' | 'reject'): ChatCompletionResponse {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            decision,
            reason:
              decision === 'allow' ? 'Requested update' : 'Unrelated document',
          }),
        },
        finish_reason: 'stop',
      },
    ],
  } as ChatCompletionResponse;
}

test('a backup and matching revision cannot skip preservation review', async () => {
  const { input, reviewFileWriteIntent, state } = await setup();
  model.call.mockResolvedValue(verdict('reject'));
  expect(await reviewFileWriteIntent(input)).toMatchObject({
    decision: 'denied',
    escalationRoute: 'policy_denial',
    pinned: true,
  });
  expect(model.call).toHaveBeenCalledOnce();
  const request = JSON.parse(model.call.mock.calls[0][0].messages[1].content);
  expect(request).toMatchObject({
    existing_content: original,
    proposed_content: replacement,
  });
  expect(state.getFileWriteConflict('session-a', 'report.md')).toBeTruthy();
  expect(fs.readFileSync(path.join(workspace, 'report.md'), 'utf8')).toBe(
    original,
  );
});

test('a legitimate hash-precondition update remains reviewable and executable', async () => {
  const { args, input, reviewFileWriteIntent, state } = await setup();
  model.call.mockResolvedValue(verdict('allow'));
  expect(
    await reviewFileWriteIntent({
      ...input,
      latestUserPrompt:
        'Replace the garden notes in report.md with software release notes.',
    }),
  ).toBe(input.evaluation);
  expect(model.call).toHaveBeenCalledOnce();
  const { runFileWrite } = await import('../container/src/tools/file-write.js');
  await runFileWrite(
    args,
    (name) => path.join(workspace, name),
    undefined,
    'session-a',
  );
  expect(fs.readFileSync(path.join(workspace, 'report.md'), 'utf8')).toBe(
    replacement,
  );
  expect(state.getFileWriteConflict('session-a', 'report.md')).toBeNull();
});

test('a stale revision never sends changed content to the reviewer', async () => {
  const { input, reviewFileWriteIntent, state } = await setup();
  fs.writeFileSync(path.join(workspace, 'report.md'), 'Newer private document');
  expect(await reviewFileWriteIntent(input)).toMatchObject({
    decision: 'denied',
  });
  expect(model.call).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(workspace, 'report.md'), 'utf8')).toBe(
    'Newer private document',
  );
  expect(state.getFileWriteConflict('session-a', 'report.md')).toBeTruthy();
});

test('the write rechecks its revision if the file changes during review', async () => {
  const { args, input, reviewFileWriteIntent } = await setup();
  model.call.mockImplementation(async () => {
    fs.writeFileSync(path.join(workspace, 'report.md'), 'Concurrent edit');
    return verdict('allow');
  });
  expect(await reviewFileWriteIntent(input)).toBe(input.evaluation);
  const { runFileWrite } = await import('../container/src/tools/file-write.js');
  await expect(
    runFileWrite(
      args,
      (name) => path.join(workspace, name),
      undefined,
      'session-a',
    ),
  ).rejects.toThrow(/Stale/);
  expect(fs.readFileSync(path.join(workspace, 'report.md'), 'utf8')).toBe(
    'Concurrent edit',
  );
});

test.each(['missing', 'directory', 'symlink', 'invalid-utf8'] as const)(
  'a %s target cannot provide a review snapshot',
  async (kind) => {
    const { args, input, reviewFileWriteIntent } = await setup();
    const target = path.join(workspace, 'report.md');
    if (kind === 'symlink') {
      fs.symlinkSync('report.md', path.join(workspace, 'alias.md'));
      args.path = 'alias.md';
    } else {
      fs.unlinkSync(target);
      if (kind === 'directory') fs.mkdirSync(target);
      if (kind === 'invalid-utf8') {
        const bytes = Buffer.from([0xff, 0xfe]);
        fs.writeFileSync(target, bytes);
        args.expected_sha256 = createHash('sha256').update(bytes).digest('hex');
      }
    }
    const evaluated = await reviewFileWriteIntent({
      ...input,
      argsJson: JSON.stringify(args),
    });
    if (kind === 'missing') {
      const { runFileWrite } = await import(
        '../container/src/tools/file-write.js'
      );
      await expect(
        runFileWrite(
          args,
          (name) => path.join(workspace, name),
          undefined,
          'session-a',
        ),
      ).rejects.toThrow();
      expect(fs.existsSync(target)).toBe(false);
    } else {
      expect(evaluated).toMatchObject({ decision: 'denied' });
    }
    expect(model.call).not.toHaveBeenCalled();
  },
);

test.each(['', '\ufeffHeading\r\n\0literal $(touch marker)\r\n'])(
  'review retains exact text bytes including BOM and empty content: %j',
  async (text) => {
    const { args, input, reviewFileWriteIntent } = await setup();
    fs.writeFileSync(path.join(workspace, 'report.md'), text);
    args.expected_sha256 = revision(text);
    model.call.mockResolvedValue(verdict('reject'));
    await reviewFileWriteIntent({ ...input, argsJson: JSON.stringify(args) });
    expect(model.call).toHaveBeenCalledOnce();
    expect(
      JSON.parse(model.call.mock.calls[0][0].messages[1].content)
        .existing_content,
    ).toBe(text);
  },
);

test('a path outside the tool roots is never read for hash review', async () => {
  const { readFileWriteReviewContent } = await import(
    '../container/src/file-write-review-content.js'
  );
  expect(() =>
    readFileWriteReviewContent('../outside.md', revision('outside')),
  ).toThrow(/escapes/);
  expect(model.call).not.toHaveBeenCalled();
});

test.each(['required', 'denied', 'approved_once'] as const)(
  'a hash retry retains the %s policy or explicit human decision',
  async (decision) => {
    const { input, reviewFileWriteIntent } = await setup();
    const evaluation = { ...input.evaluation, decision };
    expect(await reviewFileWriteIntent({ ...input, evaluation })).toBe(
      evaluation,
    );
    expect(model.call).not.toHaveBeenCalled();
  },
);
