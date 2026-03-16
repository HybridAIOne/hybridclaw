import { describe, expect, it } from 'vitest';

import {
  resolveTuiCommandLabel,
  shouldPrintTuiStartHint,
} from '../src/onboarding-tui-hint.ts';

describe('shouldPrintTuiStartHint', () => {
  it('returns false for empty input', () => {
    expect(shouldPrintTuiStartHint('')).toBe(false);
    expect(shouldPrintTuiStartHint('   ')).toBe(false);
  });

  it('returns true for onboarding commands', () => {
    expect(shouldPrintTuiStartHint('hybridclaw onboarding')).toBe(true);
  });

  it('returns false for auth and other non-onboarding commands', () => {
    expect(shouldPrintTuiStartHint('hybridclaw auth')).toBe(false);
    expect(shouldPrintTuiStartHint('hybridclaw auth status')).toBe(false);
    expect(shouldPrintTuiStartHint('hybridclaw auth login hybridai')).toBe(
      false,
    );
    expect(shouldPrintTuiStartHint('hybridclaw setup')).toBe(false);
  });

  it('returns false when tui is already launching', () => {
    expect(shouldPrintTuiStartHint('hybridclaw tui')).toBe(false);
    expect(shouldPrintTuiStartHint('hybridclaw tui --session foo')).toBe(false);
  });

  it('matches command segments case-insensitively', () => {
    expect(shouldPrintTuiStartHint('HYBRIDCLAW ONBOARDING')).toBe(true);
    expect(shouldPrintTuiStartHint('HYBRIDCLAW AUTH LOGIN')).toBe(false);
  });
});

describe('resolveTuiCommandLabel', () => {
  it('returns the matching command prefix', () => {
    expect(resolveTuiCommandLabel('hybridclaw onboarding')).toBe(
      'hybridclaw tui',
    );
    expect(resolveTuiCommandLabel('hc auth login hybridai')).toBe('hc tui');
  });

  it('falls back to hybridclaw for empty input', () => {
    expect(resolveTuiCommandLabel('')).toBe('hybridclaw tui');
  });
});
