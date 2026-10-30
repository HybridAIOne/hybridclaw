import path from 'node:path';
import { createHmac } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { parseConnectorApproval } from '#shared/connector-approval.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeDir = useTempDir('connector-approval-');
useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});
const id = '0123456789abcdef';
const args = JSON.stringify({ content: 'Example note. '.repeat(50) });
function worker(dir: string, session = 'web-test') {
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(dir, 'policy.yaml'),
    path.join(dir, 'agent.json'),
    path.join(dir, 'all.json'),
    path.join(dir, 'legacy.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setSession(session);
  runtime.setApprovalMode({ mode: 'full' });
  runtime.setMcpToolBehaviorResolver(() => ({
    kind: 'edit',
    platformApproval: true,
  }));
  return runtime;
}
test('broker requests survive worker restart, pin exact arguments and never grant lasting trust', () => {
  const dir = makeDir();
  const first = worker(dir);
  expect(
    first.evaluateToolCall({
      toolName: 'hybridai__notion__update',
      argsJson: args,
      latestUserPrompt: 'Update a note',
    }).reason,
  ).toContain('platform enforces');
  const external = {
    id,
    connector_name: 'Notion',
    tool_name: 'update',
    arguments_preview: args,
    expires_at: Date.now() + 60_000,
  };
  const card = first.registerConnectorApproval(
    external,
    'hybridai__notion__update',
    args,
    'Update a note',
  );
  expect(card).toMatchObject({
    approvalId: `cc-${id}`,
    reviewArguments: args,
    allowSession: false,
    allowAgent: false,
    allowAll: false,
  });
  expect(
    worker(dir, 'other').handleApprovalResponse([
      { role: 'user', content: `yes cc-${id}` },
    ]),
  ).toBeNull();
  const restarted = worker(dir);
  expect(
    restarted.handleApprovalResponse([
      { role: 'user', content: `yes cc-${id} for all` },
    ]),
  ).toMatchObject({
    approvalMode: 'once',
    approvedToolCall: { toolName: 'hybridai__notion__update', argsJson: args },
  });
  expect(
    restarted.handleApprovalResponse([
      { role: 'user', content: `yes cc-${id}` },
    ]),
  ).toBeNull();
  first.registerConnectorApproval(
    { ...external, id: 'abcdef0123456789' },
    'hybridai__notion__update',
    args,
    'Update a note',
  );
  expect(
    worker(dir).handleApprovalResponse([
      { role: 'user', content: 'no cc-abcdef0123456789' },
    ]),
  ).not.toHaveProperty('approvedToolCall');
  expect(parseConnectorApproval({ ...external, id: 'bad' })).toBeNull();
});

test('only a current human-owned request can receive the host proof, and upstream failure stops replay', async () => {
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', makeDir());
  vi.doMock('../src/config/config.js', () => ({
    WEB_API_TOKEN: 'host-only-test-token',
    HYBRIDAI_BASE_URL: 'https://platform.example',
  }));
  vi.doMock('../src/memory/memory-service.js', () => ({
    memoryService: { getSessionById: () => ({ agent_id: 'hy-test' }) },
  }));
  vi.doMock('../src/auth/hybridai-auth.js', () => ({
    getHybridAIApiKey: () => 'model-api-key',
  }));
  const { setPendingApproval, clearPendingApproval } = await import(
    '../src/gateway/pending-approvals.js'
  );
  const { forwardConnectorDecision, connectorDecisionRequest } = await import(
    '../src/gateway/connector-approval.js'
  );
  await setPendingApproval('web-test', {
    approvalId: `cc-${id}`,
    prompt: 'Approve the note update.',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'test-user',
  });
  expect(
    connectorDecisionRequest({
      sessionId: 'web-test',
      approvalId: `cc-${id}`,
      decision: 'approve',
    }),
  ).toMatchObject({
    agentId: 'hy-test',
    userId: 'test-user',
    content: `yes cc-${id}`,
  });
  const call = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', call);
  const answer = { approvalId: `cc-${id}`, decision: 'yes' as const };
  await expect(
    forwardConnectorDecision(answer, 'web-test', 'another-user'),
  ).rejects.toThrow('another user');
  await expect(
    forwardConnectorDecision(answer, 'other-chat', 'test-user'),
  ).rejects.toThrow('no longer pending');
  await expect(
    forwardConnectorDecision(
      { ...answer, decision: 'all' },
      'web-test',
      'test-user',
    ),
  ).rejects.toThrow('one-shot');
  expect(call).not.toHaveBeenCalled();
  await forwardConnectorDecision(answer, 'web-test', 'test-user');
  const [url, request] = call.mock.calls[0];
  expect(url).toBe(
    `https://platform.example/api/v1/connectors/approvals/${id}/runtime`,
  );
  const body = JSON.parse(request.body);
  expect(request.headers['X-Hy-Approval-Proof']).toBe(
    createHmac('sha256', 'host-only-test-token')
      .update(`hy-connector-approval-v1\n${body.timestamp}\n${id}\napprove`)
      .digest('hex'),
  );
  expect(request.body).not.toContain('host-only-test-token');
  await expect(forwardConnectorDecision(answer, 'web-test', 'test-user')).rejects.toThrow('no longer pending');
  await setPendingApproval('web-test', {approvalId:`cc-${id}`,prompt:'Approve the note update.',createdAt:Date.now(),expiresAt:Date.now()+60_000,userId:'test-user'});
  call.mockResolvedValue(new Response('{}', { status: 401 }));
  await expect(
    forwardConnectorDecision(answer, 'web-test', 'test-user'),
  ).rejects.toThrow('could not be saved');
  await clearPendingApproval('web-test');
});
