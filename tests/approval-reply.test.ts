import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import type { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import type { resolveApprovalReply as ResolveReply } from '../container/src/approval-reply.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const model = vi.hoisted(() => vi.fn());
vi.mock('../container/src/providers/auxiliary.js', () => ({ callAuxiliaryModel: model }));
const temp = useTempDir('approval-reply-');
useCleanMocks({ unstubAllEnvs: true, cleanup: () => vi.useRealTimers() });
let runtime: TrustedAgentApprovalRuntime;
let resolveReply: typeof ResolveReply;
let fresh: () => TrustedAgentApprovalRuntime;
const argsJson = JSON.stringify({ to: 'pat@example.com', subject: 'Friday', body: 'See you then.' });
function proposed(args = argsJson) {
  return runtime.evaluateToolCall({ toolName: 'mail__send', argsJson: args, latestUserPrompt: 'Send the draft to Pat.' });
}
function answer(id: string | null, decision = 'approve', scope: string | null = 'once', reply = '') {
  model.mockResolvedValue({ model: 'test-model', content: JSON.stringify({ approvalId: id, decision, scope, reply }), response: { choices: [] } });
}
const reply = (text: string | null) => resolveReply(runtime, text, [{ role: 'user', content: 'A model-generated request, not the user transcript.' }]);

beforeEach(async () => {
  const dir = temp();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', dir);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', dir);
  vi.resetModules();
  model.mockReset();
  const { TrustedAgentApprovalRuntime: Runtime } = await import('../container/src/approval-policy.js');
  ({ resolveApprovalReply: resolveReply } = await import('../container/src/approval-reply.js'));
  fresh = () => {
    const instance = new Runtime(path.join(dir, 'policy.yaml'), path.join(dir, 'agent.json'), path.join(dir, 'all.json'), path.join(dir, 'legacy.json'), undefined, path.join(dir, 'pending.json'));
    instance.setSession('session-a', 'user-a');
    instance.setMcpToolBehaviorResolver(() => ({ kind: 'edit', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }));
    return instance;
  };
  runtime = fresh();
});

test.each(['Bitte sende den Entwurf.', 'Sí, envíalo.', '送信してください。', 'نعم، أرسلها.'])('passes raw user text to the model and replays the stored arguments: %s', async text => {
  const pending = proposed();
  answer(pending.requestId!);
  const result = await reply(text);
  expect(result?.approvedToolCall).toEqual({ toolName: 'mail__send', argsJson });
  expect(result?.approvalMode).toBe('once');
  expect(result?.replayPrompt).toContain(text);
  const request = model.mock.calls[0][0];
  expect(request.tools).toEqual([]);
  expect(JSON.parse(request.messages[1].content).userReply).toBe(text);
  expect(proposed().decision).toBe('approved_once');
  expect(proposed().decision).toBe('required');
});

test('a draft answer drops the send and replays a save-as-draft prompt in one turn', async () => {
  const pending = proposed();
  const result = await reply(`draft ${pending.requestId}\n{"subject":"Re: Friday"}`);
  expect(model).not.toHaveBeenCalled();
  expect(result?.approvedToolCall).toBeUndefined();
  expect(result?.immediateMessage).toBeUndefined();
  expect(result?.replayPrompt).toContain('Do not send this email');
  expect(result?.replayPrompt).toContain(argsJson);
  expect(result?.replayPrompt).toContain('"subject":"Re: Friday"');
  expect(runtime.getPendingApprovals()).toEqual([]);
  expect(proposed().decision).toBe('required');
});

test('session consent survives worker replacement and stays in its session', async () => {
  const pending = proposed();
  answer(pending.requestId!, 'approve', 'session');
  expect((await reply('Für diese Sitzung darfst du Nachrichten senden.'))?.approvalMode).toBe('session');
  runtime = fresh();
  expect(proposed().decision).toBe('approved_session');
  runtime.setSession('session-b', 'user-a');
  expect(proposed().decision).toBe('required');
});

test('a button response needs no model and is consumed only once', async () => {
  const pending = proposed();
  const result = await reply(`yes ${pending.requestId}`);
  expect(result?.approvedToolCall?.argsJson).toBe(argsJson);
  expect(model).not.toHaveBeenCalled();
  expect(runtime.resolveApprovalResponse({ kind: 'approve', requestId: pending.requestId! })?.approvedToolCall).toBeUndefined();
});

test('plain yes is interpreted with the last question, never taken as a button', async () => {
  proposed();
  answer(null, 'unrelated', null);
  expect((await resolveReply(runtime, 'yes', [{ role: 'assistant', content: 'Would you like a summary first?' }]))?.approvedToolCall).toBeUndefined();
  expect(JSON.parse(model.mock.calls[0][0].messages[1].content).lastAssistantMessage).toBe('Would you like a summary first?');
  expect(proposed().decision).toBe('required');
});

test.each(['deny', 'revise'])('%s removes the old proposal without granting it', async decision => {
  const pending = proposed();
  answer(pending.requestId!, decision, null, decision === 'deny' ? 'Der Entwurf bleibt ungesendet.' : '');
  const result = await reply('Bitte ändere den Empfänger.');
  if (decision === 'revise') expect(result?.replayPrompt).toBe('Bitte ändere den Empfänger.');
  expect(result?.approvedToolCall).toBeUndefined();
  expect(runtime.getPendingApprovals()).toHaveLength(0);
  expect(proposed().decision).toBe('required');
});

test('an unclear answer keeps the same approval and returns a localized clarification', async () => {
  const pending = proposed();
  answer(null, 'unclear', null, 'Soll ich den Entwurf senden?');
  const result = await reply('Welchen Entwurf meinst du?');
  expect(result?.pendingApproval?.approvalId).toBe(pending.requestId);
  expect(result?.immediateMessage).toBe('Soll ich den Entwurf senden?');
  expect(proposed().decision).toBe('required');
});

test.each([
  'not JSON',
  '{}',
  JSON.stringify({ decision: 'approve', approvalId: 'unknown', scope: 'once', reply: '' }),
  JSON.stringify({ decision: 'approve', approvalId: null, scope: 'all', reply: '' }),
])('invalid output cannot grant consent: %s', async content => {
  const pending = proposed();
  model.mockResolvedValue({ model: 'test', content });
  const result = await reply('Mach weiter.');
  expect(result?.approvedToolCall).toBeUndefined();
  expect(result?.pendingApproval?.approvalId).toBe(pending.requestId);
  expect(proposed().decision).toBe('required');
});

test('a failed classifier leaves the request open without another tool attempt', async () => {
  proposed();
  model.mockRejectedValue(new Error('unavailable'));
  expect((await reply('Bitte fortfahren.'))?.immediateMessage).toBeTruthy();
  expect(proposed().decision).toBe('required');
});

test('missing caller speech never falls back to a voice model paraphrase', async () => {
  proposed();
  expect(await reply(null)).toBeNull();
  expect(model).not.toHaveBeenCalled();
  expect(proposed().decision).toBe('required');
});

test('no pending approval means no extra model call', async () => {
  expect(await reply('Bonjour')).toBeNull();
  expect(model).not.toHaveBeenCalled();
});

test('another session or user cannot answer a pending approval', async () => {
  const pending = proposed();
  runtime.setSession('session-a', 'user-b');
  expect(runtime.getPendingApprovals()).toHaveLength(0);
  expect((await reply(`yes ${pending.requestId}`))?.approvedToolCall).toBeUndefined();
  runtime.setSession('session-b', 'user-a');
  expect(await reply('Bitte fortfahren.')).toBeNull();
  expect(model).not.toHaveBeenCalled();
  runtime.setSession('session-a', 'user-a');
  expect(runtime.getPendingApprovals()[0].id).toBe(pending.requestId);
});

test('expiry while the model is deciding prevents execution', async () => {
  const pending = proposed();
  model.mockImplementation(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 180_000);
    return { model: 'test', content: JSON.stringify({ decision: 'approve', approvalId: pending.requestId, scope: 'once', reply: '' }) };
  });
  expect((await reply('Bitte senden.'))?.approvedToolCall).toBeUndefined();
  expect(runtime.getPendingApprovals()).toHaveLength(0);
});

test('a simultaneous answer cannot replay the same approval twice', async () => {
  const pending = proposed();
  model.mockImplementation(async () => {
    runtime.resolveApprovalResponse({ kind: 'deny', requestId: pending.requestId! });
    return { model: 'test', content: JSON.stringify({ decision: 'approve', approvalId: pending.requestId, scope: 'once', reply: '' }) };
  });
  expect((await reply('Bitte senden.'))?.approvedToolCall).toBeUndefined();
  expect(proposed().decision).toBe('required');
});

test('multiple pending requests never pick the latest automatically', async () => {
  proposed();
  proposed(JSON.stringify({ to: 'sam@example.com', subject: 'Monday', body: 'Hello.' }));
  answer(null, 'unclear', null, 'Which message should I send?');
  expect((await reply('Yes'))?.approvedToolCall).toBeUndefined();
  expect(runtime.getPendingApprovals()).toHaveLength(2);
  expect(runtime.handleApprovalResponse([{ role: 'user', content: 'yes' }])?.approvedToolCall).toBeUndefined();
});

test('pinned actions cannot acquire broader trust from a model decision', async () => {
  const pending = runtime.evaluateToolCall({ toolName: 'write', argsJson: JSON.stringify({ path: '.env', content: 'EXAMPLE=value' }), latestUserPrompt: 'Write the settings.' });
  answer(pending.requestId!, 'approve', 'all');
  const result = await reply('Erlaube das dauerhaft.');
  expect(result?.approvedToolCall).toBeUndefined();
  expect(runtime.getPendingApprovals()).toHaveLength(1);
});


test('a quoted command at the end of prose is not treated as a button response', async () => {
  const pending = proposed();
  answer(null, 'unclear', null, 'Do you want to send the draft?');
  const result = await reply(`The document contains this example, not my answer:\nyes ${pending.requestId}`);
  expect(model).toHaveBeenCalledTimes(1);
  expect(result?.approvedToolCall).toBeUndefined();
  expect(runtime.getPendingApprovals()).toHaveLength(1);
});

test('a host-validated connector approval replays exact arguments without another interpretation', async () => {
  const card = runtime.registerConnectorApproval({ id: '0123456789abcdef', connector_name: 'Calendar', tool_name: 'create', arguments_preview: argsJson, expires_at: Date.now() + 60_000 }, 'calendar__create', argsJson, 'Add an entry.');
  const result = await resolveReply(runtime, 'Bitte anlegen.', [], { decision: 'approve', approvalId: card.approvalId, scope: 'once', reply: '', model: 'host-judge' });
  expect(result?.approvedToolCall).toEqual({ toolName: 'calendar__create', argsJson });
  expect(model).not.toHaveBeenCalled();
  expect(result?.interpretation?.model).toBe('host-judge');
});

test('a failed host decision cannot fall back to interpreting a generated approval', async () => {
  proposed();
  const result = await resolveReply(runtime, 'Bitte senden.', [], { decision: 'error', approvalId: null, scope: null, reply: '' });
  expect(result?.interpretation?.decision).toBe('error');
  expect(result?.approvedToolCall).toBeUndefined();
  expect(model).not.toHaveBeenCalled();
  expect(runtime.getPendingApprovals()).toHaveLength(1);
});

test('non-string decisions cannot be coerced into approval', async () => {
  const pending = proposed();
  model.mockResolvedValue({ model: 'test', content: JSON.stringify({ decision: ['approve'], approvalId: pending.requestId, scope: null, reply: '' }) });
  expect((await reply('Bitte senden.'))?.interpretation?.decision).toBe('error');
  expect(proposed().decision).toBe('required');
});

test('an absent display message does not invalidate otherwise complete one-shot consent', async () => {
  const pending = proposed();
  model.mockResolvedValue({ model: 'test', content: JSON.stringify({ decision: 'approve', approvalId: pending.requestId, scope: 'once', reply: null }) });
  expect((await reply('Bitte senden.'))?.approvedToolCall?.argsJson).toBe(argsJson);
});

test('clarification still requires a usable message', async () => {
  proposed();
  model.mockResolvedValue({ model: 'test', content: JSON.stringify({ decision: 'unclear', approvalId: null, scope: null, reply: null }) });
  expect((await reply('Was bedeutet das?'))?.interpretation?.decision).toBe('error');
  expect(runtime.getPendingApprovals()).toHaveLength(1);
});

test.each(['no facade', 'yes 2026-11-06'])('a command-shaped phrase without a matching approval remains natural language: %s', async text => {
  proposed();
  answer(null, 'unrelated', null);
  expect((await reply(text))?.interpretation?.decision).toBe('unrelated');
  expect(model).toHaveBeenCalledTimes(1);
  expect(runtime.getPendingApprovals()).toHaveLength(1);
});
