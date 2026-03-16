import { describe, expect, it } from 'vitest';

import {
  resolveTuiCommandLabel,
  shouldPrintTuiStartHint,
} from '../src/onboarding-tui-hint.ts';

describe('shouldPrintTuiStartHint', () => {
  it('returns true for empty input', () => {
    expect(shouldPrintTuiStartHint('')).toBe(true);
    expect(shouldPrintTuiStartHint('   ')).toBe(true);
  });

  it('returns true for onboarding commands', () => {
    expect(shouldPrintTuiStartHint('hybridclaw onboarding')).toBe(true);
  });

  it('returns true for non-tui commands', () => {
    expect(shouldPrintTuiStartHint('hybridclaw auth')).toBe(true);
    expect(shouldPrintTuiStartHint('hybridclaw auth status')).toBe(true);
    expect(shouldPrintTuiStartHint('hybridclaw auth login hybridai')).toBe(
      true,
    );
    expect(shouldPrintTuiStartHint('hybridclaw setup')).toBe(true);
  });

  it('returns false when tui is already launching', () => {
    expect(shouldPrintTuiStartHint('hybridclaw tui')).toBe(false);
    expect(shouldPrintTuiStartHint('hybridclaw tui --session foo')).toBe(false);
  });

  it('matches command segments case-insensitively', () => {
    expect(shouldPrintTuiStartHint('HYBRIDCLAW TUI')).toBe(false);
    expect(shouldPrintTuiStartHint('HYBRIDCLAW AUTH LOGIN')).toBe(true);
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
