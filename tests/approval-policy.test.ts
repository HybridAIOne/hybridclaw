import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import { TrustedCoworkerApprovalRuntime } from '../container/src/approval-policy.js';
import type { ChatMessage } from '../container/src/types.js';

function userMessage(text: string): ChatMessage {
  return { role: 'user', content: text };
}

function tempTrustStorePath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-approval-'));
  return path.join(dir, `${name}.json`);
}

describe('TrustedCoworkerApprovalRuntime', () => {
  test('yellow actions promote to green after successful repeat', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const first = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'npm install' }),
      latestUserPrompt: 'Install dependencies',
    });
    expect(first.tier).toBe('yellow');
    expect(first.decision).toBe('implicit');

    runtime.afterToolExecution(first, true);

    const second = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'npm install' }),
      latestUserPrompt: 'Install dependencies',
    });
    expect(second.tier).toBe('green');
  });

  test('sensitive paths stay pinned red and require explicit approval', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson: JSON.stringify({ path: '.env', contents: 'API_KEY=abc' }),
      latestUserPrompt: 'Write env file',
    });

    expect(evaluation.baseTier).toBe('red');
    expect(evaluation.decision).toBe('required');
    expect(evaluation.pinned).toBe(true);
    expect(evaluation.requestId).toBeTruthy();
  });

  test('yes response approves once and replays original prompt', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );
    const originalPrompt = 'Delete dist and rebuild cleanly';

    const pending = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'rm -rf dist' }),
      latestUserPrompt: originalPrompt,
    });
    expect(pending.decision).toBe('required');

    const prelude = runtime.handleApprovalResponse([userMessage('yes')]);
    expect(prelude?.replayPrompt).toBe(originalPrompt);
    expect(prelude?.approvalMode).toBe('once');

    const approved = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'rm -rf dist' }),
      latestUserPrompt: originalPrompt,
    });
    expect(approved.decision).toBe('approved_once');
  });

  test('yes for session persists trust for repeated action key', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );
    const originalPrompt = 'Fetch from example.com';

    const first = runtime.evaluateToolCall({
      toolName: 'web_fetch',
      argsJson: JSON.stringify({ url: 'https://example.com' }),
      latestUserPrompt: originalPrompt,
    });
    expect(first.decision).toBe('required');

    const prelude = runtime.handleApprovalResponse([
      userMessage('yes for session'),
    ]);
    expect(prelude?.approvalMode).toBe('session');

    const second = runtime.evaluateToolCall({
      toolName: 'web_fetch',
      argsJson: JSON.stringify({ url: 'https://example.com' }),
      latestUserPrompt: originalPrompt,
    });
    expect(second.decision).toBe('approved_session');
  });

  test('pinned red cannot be session-trusted across runs', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );
    const prompt = 'Append token to .env';

    const first = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson: JSON.stringify({ path: '.env', contents: 'TOKEN=x' }),
      latestUserPrompt: prompt,
    });
    expect(first.decision).toBe('required');
    expect(first.pinned).toBe(true);

    const prelude = runtime.handleApprovalResponse([
      userMessage('yes for session'),
    ]);
    expect(prelude?.approvalMode).toBe('once');

    const second = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson: JSON.stringify({ path: '.env', contents: 'TOKEN=x' }),
      latestUserPrompt: prompt,
    });
    expect(second.decision).toBe('approved_once');

    const third = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson: JSON.stringify({ path: '.env', contents: 'TOKEN=x' }),
      latestUserPrompt: prompt,
    });
    expect(third.decision).toBe('required');
  });

  test('yes for agent persists trust across runtime restarts', () => {
    const trustStorePath = tempTrustStorePath('agent-trust');
    const policyPath = '/tmp/hybridclaw-missing-policy.yaml';
    const prompt = 'Fetch from example.com';
    const argsJson = JSON.stringify({ url: 'https://example.com' });

    const runtime = new TrustedCoworkerApprovalRuntime(
      policyPath,
      trustStorePath,
    );
    const first = runtime.evaluateToolCall({
      toolName: 'web_fetch',
      argsJson,
      latestUserPrompt: prompt,
    });
    expect(first.decision).toBe('required');

    const prelude = runtime.handleApprovalResponse([
      userMessage('yes for agent'),
    ]);
    expect(prelude?.approvalMode).toBe('agent');

    const second = runtime.evaluateToolCall({
      toolName: 'web_fetch',
      argsJson,
      latestUserPrompt: prompt,
    });
    expect(second.decision).toBe('approved_agent');

    const restarted = new TrustedCoworkerApprovalRuntime(
      policyPath,
      trustStorePath,
    );
    const third = restarted.evaluateToolCall({
      toolName: 'web_fetch',
      argsJson,
      latestUserPrompt: prompt,
    });
    expect(third.decision).toBe('approved_agent');
  });

  test('pinned red cannot be agent-trusted across restarts', () => {
    const trustStorePath = tempTrustStorePath('pinned-agent');
    const policyPath = '/tmp/hybridclaw-missing-policy.yaml';
    const prompt = 'Write .env';
    const argsJson = JSON.stringify({ path: '.env', contents: 'TOKEN=abc' });

    const runtime = new TrustedCoworkerApprovalRuntime(
      policyPath,
      trustStorePath,
    );
    const first = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson,
      latestUserPrompt: prompt,
    });
    expect(first.decision).toBe('required');
    expect(first.pinned).toBe(true);

    const prelude = runtime.handleApprovalResponse([userMessage('3')]);
    expect(prelude?.approvalMode).toBe('once');

    const second = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson,
      latestUserPrompt: prompt,
    });
    expect(second.decision).toBe('approved_once');

    const restarted = new TrustedCoworkerApprovalRuntime(
      policyPath,
      trustStorePath,
    );
    const third = restarted.evaluateToolCall({
      toolName: 'write',
      argsJson,
      latestUserPrompt: prompt,
    });
    expect(third.decision).toBe('required');
  });
});
