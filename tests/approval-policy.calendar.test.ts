import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';
const temp = useTempDir('calendar-policy-');
const toolName = 'hybridai__google_workspace__create_event';
const personal = { calendar_id: 'primary', summary: 'Read a book', start: '2026-11-06T18:00:00+01:00', end: '2026-11-06T19:00:00+01:00', time_zone: 'Europe/Berlin', send_updates: 'none' };
function evaluate(args: Record<string, unknown>, tool = toolName, mode: 'auto' | 'ask' = 'auto', destructive = false) {
  const dir = temp();
  const runtime = new TrustedAgentApprovalRuntime(path.join(dir, 'policy.yaml'), path.join(dir, 'agent.json'), path.join(dir, 'all.json'), path.join(dir, 'legacy.json'), undefined, path.join(dir, 'pending.json'));
  runtime.setApprovalMode({ mode });
  runtime.setMcpToolBehaviorResolver(() => ({ kind: destructive ? 'delete' : 'edit', annotations: { readOnlyHint: false, destructiveHint: destructive, openWorldHint: true } }));
  return runtime.evaluateToolCall({ toolName: tool, argsJson: JSON.stringify(args), latestUserPrompt: 'Add time for reading.' });
}

test.each([personal, { ...personal, attendees: [] }])('a personal entry without notifications is a normal write', args => {
  expect(evaluate(args)).toMatchObject({ tier: 'yellow', decision: 'implicit' });
});

test.each([
  { ...personal, attendees: ['pat@example.com'] },
  { ...personal, attendees: [{ email: 'pat@example.com' }] },
  { ...personal, attendees: null },
  { ...personal, attendees: '' },
  { ...personal, send_updates: 'all' },
  { ...personal, send_updates: 'externalOnly' },
  { ...personal, send_updates: undefined },
  { ...personal, calendar_id: 'team' },
  { ...personal, visibility: 'public' },
  { ...personal, sendNotifications: true },
  { ...personal, guests: ['pat@example.com'] },
])('outbound, unknown or ambiguous calendar arguments remain gated: %j', args => {
  expect(evaluate(args)).toMatchObject({ tier: 'red', decision: 'required' });
});

test('a similar tool name cannot inherit this contract', () => {
  expect(evaluate(personal, 'other__create_event').decision).toBe('required');
  expect(evaluate(personal, 'hybridai__google_workspace__update_event').decision).toBe('required');
});

test('ask mode and destructive metadata still require approval', () => {
  expect(evaluate(personal, toolName, 'ask').decision).toBe('required');
  expect(evaluate(personal, toolName, 'auto', true).decision).toBe('required');
});
