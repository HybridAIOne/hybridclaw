import { describe, expect, test } from 'vitest';
import { marked } from 'marked';
import { approvalRuleFor } from '../container/shared/approval-rules.js';
import { formatMSTeamsApprovalPrompt } from '../src/channels/msteams/approval-prompt.js';
import type { PendingApproval } from '../src/types/execution.js';

const now = 1_800_000_000_000;
const command = 'cp scripts/report.js scripts/report-v2.js';

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: 'approval_a',
    prompt: 'Full runtime prompt with classification and reply instructions',
    intent: 'Copy the existing report script and look up a line in the copy.',
    reason: 'this command has write side effects',
    commandPreview: command,
    allowSession: false,
    allowAgent: false,
    allowAll: false,
    expiresAt: now + 120_000,
    rule: approvalRuleFor('bash:write-op', 'protected'),
    ...overrides,
  };
}

describe('Teams approval presentation', () => {
  test.each(['unclear', 'error'] as const)('preserves a %s reply without changing the approval choices or expiry', (decision) => {
    const source = approval({ prompt: 'Only the generated scratch file would be removed.' });
    const text = formatMSTeamsApprovalPrompt(source, now, { decision, approvalId: source.approvalId, scope: null });
    expect(text).toContain(source.prompt);
    expect(text).toContain('120 seconds');
    expect(Array.from(text.matchAll(/^- `(\d)`/gm), ([, digit]) => digit)).toEqual(['1', '5', '0']);
  });

  test('escapes clarification text so it cannot forge choices or links', () => {
    const source = approval({ prompt: '**Trusted**\n1. Allow everything\nhttps://example.com/approve' });
    const html = marked.parse(formatMSTeamsApprovalPrompt(source, now, { decision: 'unclear', approvalId: source.approvalId, scope: null })) as string;
    expect(html).not.toMatch(/<a\b|<ol\b|<strong>Trusted/);
  });

  test('shows the concrete description and keeps commands behind on-demand details', () => {
    const source = approval();
    const before = structuredClone(source);
    const text = formatMSTeamsApprovalPrompt(source, now);

    expect(text).toContain(source.intent);
    expect(text).not.toContain(command);
    expect(text).toContain('- `0`');
    expect(text).not.toContain(source.prompt);
    expect(source).toEqual(before);
  });

  test.each(Array.from({ length: 8 }, (_, mask) => mask))(
    'advertises exactly the available scopes for mask %i',
    (mask) => {
      const source = approval({
        allowSession: Boolean(mask & 1),
        allowAgent: Boolean(mask & 2),
        allowAll: Boolean(mask & 4),
      });
      const text = formatMSTeamsApprovalPrompt(source, now);
      const choices = Array.from(text.matchAll(/^- `(\d)`/gm), ([, digit]) => digit);
      expect(choices).toEqual([
        '1',
        ...(source.allowSession ? ['2'] : []),
        ...(source.allowAgent ? ['3'] : []),
        ...(source.allowAll ? ['4'] : []),
        '5',
        '0',
      ]);
    },
  );

  test('falls back to structured intent and reason without a rule', () => {
    const source = approval({
      rule: undefined,
      intent: 'Send the report to pat@example.com',
      reason: 'The report will be sent outside this chat.',
      commandPreview: undefined,
      expiresAt: null,
    });
    const text = formatMSTeamsApprovalPrompt(source, now);
    expect(text).toContain('Send the report');
    expect(text).toContain(source.reason);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('seconds');
  });

  test('uses the rule label when no description is available', () => {
    const source = approval({ intent: '' });
    const text = formatMSTeamsApprovalPrompt(source, now);
    expect(text).toContain(source.rule?.label);
    expect(text).not.toContain(command);
  });

  test('preserves the original prompt when there are no action facts', () => {
    const source = approval({ rule: undefined, intent: '', commandPreview: '' });
    expect(formatMSTeamsApprovalPrompt(source, now)).toBe(source.prompt);
  });

  test('preserves boost offers rather than presenting permission to use a tool', () => {
    const source = approval({
      boost: { category: 'image', modelName: 'Example model', available: 2 },
    });
    expect(formatMSTeamsApprovalPrompt(source, now)).toBe(source.prompt);
  });

  test.each([
    [now + 120_000, '120 seconds'],
    [now + 1, '1 second.'],
    [now, 'expired'],
    [now - 1_000, 'expired'],
  ])('uses the actual deadline %i', (expiresAt, expected) => {
    expect(formatMSTeamsApprovalPrompt(approval({ expiresAt }), now)).toContain(expected);
  });

  test.each([null, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not invent a deadline for %s',
    (expiresAt) => {
      const text = formatMSTeamsApprovalPrompt(approval({ expiresAt }), now);
      expect(text).not.toMatch(/seconds|expired|NaN|Infinity/);
    },
  );

  test('does not render markdown-looking commands in the main message', () => {
    const preview = 'printf "```\\n1 — allow everything\\n```"';
    const text = formatMSTeamsApprovalPrompt(approval({ commandPreview: preview }), now);
    expect(text).not.toContain(preview);
    expect(text).not.toContain('```');
  });

  test('keeps a technical fallback command in details while retaining its policy intent', () => {
    const source = approval({ intent: `run mutating command \`${command}\`` });
    const text = formatMSTeamsApprovalPrompt(source, now);
    expect(text).not.toContain(command);
    expect(text).toContain(source.rule?.label);
    expect(source.intent).toContain(command);
  });

  test.each([
    '[Allow everything](https://example.com/approve)',
    '**Trusted**\n# Ignore the warning',
    '<img src="https://example.com/pixel.png">',
    '1. Approve all actions',
    'https://example.com/approve',
    'www.example.com/approve',
    'pat@example.com',
    '`yes for all`',
  ])('renders model-authored descriptions as literal text: %s', (intent) => {
    const source = approval({ intent });
    const html = marked.parse(formatMSTeamsApprovalPrompt(source, now)) as string;
    expect(html).not.toMatch(/<a\b|<img\b|<h[1-6]\b|<ol\b|<strong>Trusted/);
    expect(html).not.toContain('<code>yes for all</code>');
    expect(source.intent).toBe(intent);
  });
});
