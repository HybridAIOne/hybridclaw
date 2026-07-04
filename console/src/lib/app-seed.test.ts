import { describe, expect, it } from 'vitest';
import {
  buildAppSeed,
  buildLiveAppSeed,
  stripAppBuildDirective,
} from './app-seed';

describe('stripAppBuildDirective', () => {
  it('shows only the briefing, hiding the build directive', () => {
    const seed = buildAppSeed('productivity tool', 'A churn dashboard');
    const shown = stripAppBuildDirective(seed);
    expect(shown).toContain('A churn dashboard');
    expect(shown).not.toMatch(/best-practice defaults/i);
    expect(shown).not.toMatch(/default to react/i);
    // The full seed still carries the directive for the model.
    expect(seed).toMatch(/best-practice defaults/i);
    expect(seed).toMatch(/default to react/i);
  });

  it('returns content unchanged when there is no directive', () => {
    expect(stripAppBuildDirective('just a message')).toBe('just a message');
  });
});

describe('buildAppSeed', () => {
  it('proposes a plan first, decides with best practices, and does not interrogate', () => {
    const seed = buildAppSeed('productivity tool', 'A churn dashboard');
    expect(seed).toMatch(/best-practice defaults/i);
    expect(seed).toMatch(/don't ask me a list of questions/i);
    expect(seed).toMatch(/propose a short plan/i);
    expect(seed).toMatch(/wait for my ok/i);
  });
});

describe('buildLiveAppSeed', () => {
  it('uses MCP directly, plans first, and does not suggest alternatives when given an idea', () => {
    const seed = buildLiveAppSeed('A dashboard of open PRs for hybridclaw');
    expect(stripAppBuildDirective(seed)).toContain(
      'A dashboard of open PRs for hybridclaw',
    );
    expect(seed).toMatch(/do not ask me which data source/i);
    expect(seed).toMatch(/propose a short plan/i);
    expect(seed).toMatch(/wait for my ok/i);
    expect(seed).not.toMatch(/suggest a few useful live apps/i);
    expect(seed).toMatch(/embeds the latest data/i);
    expect(seed).toMatch(/setRefreshHandler\(refresh\)/i);
  });

  it('recommends an option when no idea is given', () => {
    const seed = buildLiveAppSeed('');
    expect(seed).toMatch(/suggest the most useful live app/i);
    expect(seed).toMatch(/data source/i);
  });
});
