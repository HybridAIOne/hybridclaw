import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  test('message read-only actions are green', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const read = runtime.evaluateToolCall({
      toolName: 'message',
      argsJson: JSON.stringify({ action: 'read', limit: 10 }),
      latestUserPrompt: 'What did Bob say?',
    });
    const memberInfo = runtime.evaluateToolCall({
      toolName: 'message',
      argsJson: JSON.stringify({ action: 'member-info', user: '@alice' }),
      latestUserPrompt: 'Who is @alice?',
    });
    const channelInfo = runtime.evaluateToolCall({
      toolName: 'message',
      argsJson: JSON.stringify({ action: 'channel-info' }),
      latestUserPrompt: 'What channel is this?',
    });

    expect(read.tier).toBe('green');
    expect(memberInfo.tier).toBe('green');
    expect(channelInfo.tier).toBe('green');
  });

  test('read-like MCP tools are green', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'tavily__search',
      argsJson: JSON.stringify({ query: 'hybridclaw mcp' }),
      latestUserPrompt: 'Search for MCP docs',
    });

    expect(evaluation.tier).toBe('green');
    expect(evaluation.actionKey).toBe('mcp:tavily:search');
  });

  test('execute-like MCP tools are red', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'runner__exec_command',
      argsJson: JSON.stringify({ command: 'npm test' }),
      latestUserPrompt: 'Run the tests',
    });

    expect(evaluation.tier).toBe('red');
    expect(evaluation.decision).toBe('required');
    expect(evaluation.actionKey).toBe('mcp:runner:execute');
  });

  test('read-only bundled PDF extraction commands are green', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({
        command:
          'node skills/pdf/scripts/extract_pdf_text.mjs invoice.pdf --json',
      }),
      latestUserPrompt: 'Read this invoice PDF',
    });

    expect(evaluation.tier).toBe('green');
    expect(evaluation.actionKey).toBe('bash:pdf-read-only');
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
    expect(prelude?.replayPrompt).toContain('Approval already granted');
    expect(prelude?.replayPrompt).toContain(originalPrompt);
    expect(prelude?.replayPrompt).toContain('Do not ask for approval again');
    expect(prelude?.approvalMode).toBe('once');

    const approved = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'rm -rf dist' }),
      latestUserPrompt: originalPrompt,
    });
    expect(approved.decision).toBe('approved_once');
    expect(approved.implicitDelayMs).toBeUndefined();
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

  test('network approvals reuse site scope across subdomains', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );
    const originalPrompt = 'Open Google Images';

    const first = runtime.evaluateToolCall({
      toolName: 'browser_navigate',
      argsJson: JSON.stringify({ url: 'https://images.google.de' }),
      latestUserPrompt: originalPrompt,
    });
    expect(first.decision).toBe('required');
    expect(first.actionKey).toBe('network:google.de');

    const prelude = runtime.handleApprovalResponse([userMessage('yes')]);
    expect(prelude?.approvalMode).toBe('once');

    const second = runtime.evaluateToolCall({
      toolName: 'browser_navigate',
      argsJson: JSON.stringify({ url: 'https://www.google.de' }),
      latestUserPrompt: originalPrompt,
    });
    expect(second.actionKey).toBe('network:google.de');
    expect(second.decision).toBe('promoted');
    expect(second.tier).toBe('yellow');
  });

  test('approval prompt lists options in 1/2/3/4 order for non-pinned actions', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'web_fetch',
      argsJson: JSON.stringify({ url: 'https://example.com' }),
      latestUserPrompt: 'Fetch page',
    });
    expect(evaluation.decision).toBe('required');
    expect(evaluation.pinned).toBe(false);

    const prompt = runtime.formatApprovalRequest(evaluation);
    const onceIdx = prompt.indexOf('Reply `yes` (or `1`) to approve once.');
    const sessionIdx = prompt.indexOf(
      'Reply `yes for session` (or `2`) to trust this action for this session.',
    );
    const agentIdx = prompt.indexOf(
      'Reply `yes for agent` (or `3`) to trust it for this agent.',
    );
    const denyIdx = prompt.indexOf('Reply `no` (or `4`) to deny.');

    expect(onceIdx).toBeGreaterThanOrEqual(0);
    expect(sessionIdx).toBeGreaterThan(onceIdx);
    expect(agentIdx).toBeGreaterThan(sessionIdx);
    expect(denyIdx).toBeGreaterThan(agentIdx);
  });

  test('approval prompt marks session/agent trust unavailable for pinned actions', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson: JSON.stringify({ path: '.env', contents: 'TOKEN=abc' }),
      latestUserPrompt: 'Write env file',
    });
    expect(evaluation.decision).toBe('required');
    expect(evaluation.pinned).toBe(true);

    const prompt = runtime.formatApprovalRequest(evaluation);
    expect(prompt).toContain(
      'Reply `yes for session` (or `2`) is unavailable for pinned-sensitive actions.',
    );
    expect(prompt).toContain(
      'Reply `yes for agent` (or `3`) is unavailable for pinned-sensitive actions.',
    );
  });

  test('approval parser accepts wrapped Discord batch reply "Message 1: 3"', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );
    const originalPrompt = 'Open images.google.de';
    const argsJson = JSON.stringify({ url: 'https://images.google.de' });

    const first = runtime.evaluateToolCall({
      toolName: 'browser_navigate',
      argsJson,
      latestUserPrompt: originalPrompt,
    });
    expect(first.decision).toBe('required');

    const wrappedReply = [
      '[Channel info]',
      '- Channel: #chat',
      '',
      'Message 1:',
      '3',
    ].join('\n');
    const prelude = runtime.handleApprovalResponse([userMessage(wrappedReply)]);
    expect(prelude?.approvalMode).toBe('agent');
    expect(prelude?.replayPrompt).toContain(originalPrompt);

    const second = runtime.evaluateToolCall({
      toolName: 'browser_navigate',
      argsJson,
      latestUserPrompt: originalPrompt,
    });
    expect(second.decision).toBe('approved_agent');
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

  test('scratch outputs under /tmp do not trigger workspace-fence approvals', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({
        command:
          "mkdir -p /tmp/hybridclaw-pdf && sips -s format png '/Users/example/invoice.pdf' --out /tmp/hybridclaw-pdf/invoice.png",
      }),
      latestUserPrompt: 'Extract the invoice data',
    });

    expect(evaluation.baseTier).toBe('yellow');
    expect(evaluation.decision).toBe('implicit');
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
