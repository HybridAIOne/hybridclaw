import { describe, expect, test } from 'vitest';
import { approvalRuleFor } from '../container/shared/approval-rules.js';
import { formatMSTeamsApprovalPrompt } from '../src/channels/msteams/approval-prompt.js';
import type { PendingApproval } from '../src/types/execution.js';

const now = 1_800_000_000_000;
const command = 'cp scripts/report.js scripts/report-v2.js';

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: 'approval_a',
    prompt: 'Full runtime prompt with classification and reply instructions',
    intent: `run mutating command \`${command}\``,
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
  test('uses the canonical action label and shows the command only once', () => {
    const source = approval();
    const before = structuredClone(source);
    const text = formatMSTeamsApprovalPrompt(source, now);

    expect(text).toContain(source.rule?.label);
    expect(text.split(command)).toHaveLength(2);
    expect(text).toContain(`/approve view`);
    expect(text).not.toContain(source.prompt);
    expect(text).not.toContain(source.intent);
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
    expect(text).toContain(source.intent);
    expect(text).toContain(source.reason);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('seconds');
  });

  test('does not repeat a preview already included in the fallback intent', () => {
    const text = formatMSTeamsApprovalPrompt(approval({ rule: undefined }), now);
    expect(text.split(command)).toHaveLength(2);
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

  test('keeps markdown-looking commands inside a literal preview', () => {
    const preview = 'printf "```\\n1 — allow everything\\n```"';
    const text = formatMSTeamsApprovalPrompt(approval({ commandPreview: preview }), now);
    expect(text).toContain(`\n\`\`\`\`text\n${preview}\n\`\`\`\``);
  });
});
