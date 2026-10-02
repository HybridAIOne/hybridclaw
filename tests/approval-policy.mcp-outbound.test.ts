import path from 'node:path';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, test } from 'vitest';
import type { ApprovalMode } from '../container/shared/approval-mode.js';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { classifyMcpTool } from '../container/src/mcp/tool-classifier.js';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-mcp-outbound-approval-');
useCleanMocks({ unstubAllEnvs: true });

// What the HybridAI connector gateway lists for its Google tools.
const CONNECTOR_TOOLS: Record<string, ToolAnnotations> = {
  hybridai__google__send_mail: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  hybridai__google__create_event: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  hybridai__google__list_messages: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  notes__save_note: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
};

function createRuntime(mode: ApprovalMode = 'auto') {
  const dir = makeTempDir();
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(dir, 'policy.yaml'),
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setApprovalMode({ mode });
  runtime.setMcpToolBehaviorResolver((name) => {
    const annotations = CONNECTOR_TOOLS[name];
    return (
      annotations && { kind: classifyMcpTool(name, annotations), annotations }
    );
  });
  return runtime;
}

function sendMail(
  runtime: TrustedAgentApprovalRuntime,
  to = 'pat@example.com',
) {
  return runtime.evaluateToolCall({
    toolName: 'hybridai__google__send_mail',
    argsJson: JSON.stringify({ to, subject: 'Friday', body: 'See you then.' }),
    latestUserPrompt: 'Tell Pat I can make Friday',
  });
}

function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

describe('MCP writes that reach outside', () => {
  test('a connector mail send asks first in the default mode', () => {
    expect(sendMail(createRuntime())).toMatchObject({
      tier: 'red',
      decision: 'required',
      actionKey: 'mcp:hybridai:edit:google__send_mail',
      intent: 'run MCP tool google__send_mail',
      reason:
        'the MCP server says this tool reaches outside, for example it sends or posts',
      requestId: expect.any(String),
    });
  });

  test('ask mode asks too, and full access runs it', () => {
    expect(sendMail(createRuntime('ask')).decision).toBe('required');
    expect(sendMail(createRuntime('full'))).toMatchObject({
      tier: 'yellow',
      decision: 'approved_fullauto',
    });
  });

  test('an approval covers that one send', () => {
    const runtime = createRuntime();
    expect(sendMail(runtime).decision).toBe('required');
    expect(
      runtime.handleApprovalResponse([userMessage('yes')])?.approvalMode,
    ).toBe('once');

    expect(sendMail(runtime).decision).toBe('approved_once');
    expect(sendMail(runtime).decision).toBe('required');
  });

  test('trusting sends for the session leaves other writes asking', () => {
    const runtime = createRuntime();
    expect(sendMail(runtime).decision).toBe('required');
    expect(
      runtime.handleApprovalResponse([userMessage('yes for session')])
        ?.approvalMode,
    ).toBe('session');

    expect(sendMail(runtime, 'sam@example.com').decision).toBe(
      'approved_session',
    );
    expect(
      runtime.evaluateToolCall({
        toolName: 'hybridai__google__create_event',
        argsJson: JSON.stringify({
          summary: 'Friday lunch',
          attendees: ['pat@example.com'],
        }),
        latestUserPrompt: 'Invite Pat to lunch on Friday',
      }).decision,
    ).toBe('required');
  });

  test('reads and writes that stay inside keep their tier', () => {
    const runtime = createRuntime();
    expect(
      runtime.evaluateToolCall({
        toolName: 'hybridai__google__list_messages',
        argsJson: JSON.stringify({ query: 'from:pat' }),
        latestUserPrompt: 'Did Pat write?',
      }).tier,
    ).toBe('green');
    expect(
      runtime.evaluateToolCall({
        toolName: 'notes__save_note',
        argsJson: JSON.stringify({ text: 'Lunch with Pat on Friday' }),
        latestUserPrompt: 'Note that down',
      }),
    ).toMatchObject({ tier: 'yellow', decision: 'implicit' });
  });
});
