import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { TrustedCoworkerApprovalRuntime } from '../container/src/approval-policy.js';
import type { ChatMessage } from '../container/src/types.js';

function userMessage(text: string): ChatMessage {
  return { role: 'user', content: text };
}

function tempTrustStorePath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-approval-'));
  return path.join(dir, `${name}.json`);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  test('vision analysis tools are green and do not wait for interruption', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const visionAnalyze = runtime.evaluateToolCall({
      toolName: 'vision_analyze',
      argsJson: JSON.stringify({
        image_url: '/tmp/example.jpg',
        question: 'What is in this image?',
      }),
      latestUserPrompt: 'Analyze the attached image',
    });
    const imageAlias = runtime.evaluateToolCall({
      toolName: 'image',
      argsJson: JSON.stringify({
        image_url: '/tmp/example.jpg',
        question: 'What is in this image?',
      }),
      latestUserPrompt: 'Analyze the attached image',
    });

    expect(visionAnalyze.tier).toBe('green');
    expect(visionAnalyze.decision).toBe('auto');
    expect(visionAnalyze.implicitDelayMs).toBeUndefined();
    expect(imageAlias.tier).toBe('green');
    expect(imageAlias.decision).toBe('auto');
    expect(imageAlias.implicitDelayMs).toBeUndefined();
  });

  test('non-input browser tools skip the implicit interruption delay', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'browser_click',
      argsJson: JSON.stringify({ ref: '@e5' }),
      latestUserPrompt: 'Open the selected book',
    });

    expect(evaluation.tier).toBe('yellow');
    expect(evaluation.decision).toBe('implicit');
    expect(evaluation.implicitDelayMs).toBeUndefined();
    expect(runtime.formatYellowNarration(evaluation)).toBe('run browser_click');
  });

  test('input-like browser tools keep the implicit interruption delay', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'browser_type',
      argsJson: JSON.stringify({ ref: '@e9', text: 'search term' }),
      latestUserPrompt: 'Type into the search box',
    });

    expect(evaluation.tier).toBe('yellow');
    expect(evaluation.decision).toBe('implicit');
    expect(evaluation.implicitDelayMs).toBe(5_000);
    expect(runtime.formatYellowNarration(evaluation)).toContain(
      'Waiting 5s for interruption before running.',
    );
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

  test('full-auto mode auto-approves red actions without creating a pending prompt', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );
    runtime.setFullAutoOptions({ enabled: true });

    const evaluation = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson: JSON.stringify({ path: '.env', contents: 'API_KEY=abc' }),
      latestUserPrompt: 'Write env file',
    });

    expect(evaluation.baseTier).toBe('red');
    expect(evaluation.decision).toBe('approved_fullauto');
    expect(evaluation.tier).toBe('yellow');
    expect(evaluation.requestId).toBeUndefined();
  });

  test('full-auto mode still requires approval for tools on the never-approve list', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );
    runtime.setFullAutoOptions({
      enabled: true,
      neverApproveTools: ['write'],
    });

    const evaluation = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson: JSON.stringify({ path: '.env', contents: 'API_KEY=abc' }),
      latestUserPrompt: 'Write env file',
    });

    expect(evaluation.baseTier).toBe('red');
    expect(evaluation.decision).toBe('required');
    expect(evaluation.requestId).toBeTruthy();
  });

  test('host app control commands require explicit approval', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const openApp = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'open -a Music' }),
      latestUserPrompt: 'Open Apple Music',
    });
    const appleScript = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({
        command: `osascript -e 'tell application "Music" to playpause'`,
      }),
      latestUserPrompt: 'Toggle Apple Music playback',
    });
    const appScheme = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'open "music://"' }),
      latestUserPrompt: 'Open Apple Music',
    });

    expect(openApp.baseTier).toBe('red');
    expect(openApp.decision).toBe('required');
    expect(openApp.actionKey).toBe('bash:host-control');
    expect(openApp.requestId).toBeTruthy();

    expect(appleScript.baseTier).toBe('red');
    expect(appleScript.decision).toBe('required');
    expect(appleScript.actionKey).toBe('bash:host-control');
    expect(appleScript.requestId).toBeTruthy();

    expect(appScheme.baseTier).toBe('red');
    expect(appScheme.decision).toBe('required');
    expect(appScheme.actionKey).toBe('bash:host-control');
    expect(appScheme.requestId).toBeTruthy();
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

  test('approval prompt lists text approval options in order for non-pinned actions', () => {
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
    const onceIdx = prompt.indexOf('Reply `yes` to approve once.');
    const sessionIdx = prompt.indexOf(
      'Reply `yes for session` to trust this action for this session.',
    );
    const agentIdx = prompt.indexOf(
      'Reply `yes for agent` to trust it for this agent.',
    );
    const denyIdx = prompt.indexOf('Reply `no` to deny.');

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
      'Reply `yes for session` is unavailable for pinned-sensitive actions.',
    );
    expect(prompt).toContain(
      'Reply `yes for agent` is unavailable for pinned-sensitive actions.',
    );
  });

  test('approval parser accepts wrapped Discord batch reply "Message 1: yes for agent"', () => {
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
      'yes for agent',
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

  test('node heredocs are not treated as workspace writes based on JS arrow functions or comments', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({
        command: [
          "node - <<'NODE'",
          "const ExcelJS = require('exceljs');",
          "const path='/Users/example/input.xlsx';",
          '(async()=>{',
          '  const wb=new ExcelJS.Workbook();',
          '  await wb.xlsx.readFile(path);',
          "  const ws=wb.getWorksheet('Summary');",
          '  for(let r=1;r<=ws.actualRowCount;r++){',
          '    const vals=ws.getRow(r).values;',
          "    if(!vals.some(v=>v!==null&&v!==undefined&&v!=='')) continue;",
          '    // print first 10 cols with indexes',
          "    console.log(`${r}: ${vals.join(' | ')}`);",
          '  }',
          '})();',
          'NODE',
        ].join('\n'),
      }),
      latestUserPrompt: 'Inspect the workbook summary',
    });

    expect(evaluation.actionKey).not.toBe('bash:workspace-fence');
    expect(evaluation.decision).toBe('implicit');
    expect(evaluation.tier).toBe('yellow');
  });

  test('outer-shell redirections in heredoc commands still trigger workspace-fence approvals', () => {
    const runtime = new TrustedCoworkerApprovalRuntime(
      '/tmp/hybridclaw-missing-policy.yaml',
    );

    const evaluation = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({
        command: [
          "node - <<'NODE' > /Users/example/out.txt",
          "console.log('hello');",
          'NODE',
        ].join('\n'),
      }),
      latestUserPrompt: 'Write the output to a host file',
    });

    expect(evaluation.actionKey).toBe('bash:workspace-fence');
    expect(evaluation.decision).toBe('required');
    expect(evaluation.intent).toContain('/Users/example/out.txt');
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

    const prelude = runtime.handleApprovalResponse([
      userMessage('yes for agent'),
    ]);
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

  test('default host-mode trust store persists under the actual workspace root', async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-approval-workspace-'),
    );
    const stateDir = path.join(workspaceRoot, '.hybridclaw');
    fs.mkdirSync(stateDir, { recursive: true });
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    vi.resetModules();

    const prompt = 'Open hybridclaw.io';
    const argsJson = JSON.stringify({ url: 'https://hybridclaw.io' });
    const trustStorePath = path.join(stateDir, 'approval-trust.json');

    const { TrustedCoworkerApprovalRuntime: HostModeApprovalRuntime } =
      await import('../container/src/approval-policy.js');

    const runtime = new HostModeApprovalRuntime();
    const first = runtime.evaluateToolCall({
      toolName: 'browser_navigate',
      argsJson,
      latestUserPrompt: prompt,
    });
    expect(first.decision).toBe('required');

    const prelude = runtime.handleApprovalResponse([
      userMessage('yes for agent'),
    ]);
    expect(prelude?.approvalMode).toBe('agent');
    expect(fs.existsSync(trustStorePath)).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(trustStorePath, 'utf-8')) as {
      trustedActions?: string[];
    };
    expect(persisted.trustedActions).toContain('network:hybridclaw.io');

    const restarted = new HostModeApprovalRuntime();
    const second = restarted.evaluateToolCall({
      toolName: 'browser_navigate',
      argsJson,
      latestUserPrompt: prompt,
    });
    expect(second.decision).toBe('approved_agent');
  });
});
