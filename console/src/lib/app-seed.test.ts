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
    // Briefing is visible…
    expect(shown).toContain('A churn dashboard');
    // …but the build instructions are not shown.
    expect(shown).not.toMatch(/before building/i);
    expect(shown).not.toMatch(/default to react/i);
    // The full seed still carries the directive for the model.
    expect(seed).toMatch(/before building/i);
    expect(seed).toMatch(/default to react/i);
  });

  it('returns content unchanged when there is no directive', () => {
    expect(stripAppBuildDirective('just a message')).toBe('just a message');
  });
});

describe('buildAppSeed', () => {
  it('refines a provided idea and does not suggest alternatives', () => {
    const seed = buildAppSeed('productivity tool', 'A churn dashboard');
    expect(seed).toMatch(/refine this briefing/i);
    expect(seed).toMatch(/don't suggest a different app/i);
    expect(seed).toMatch(/propose a short plan/i);
  });
});

describe('buildLiveAppSeed', () => {
  it('uses MCP connectors directly and does not suggest alternatives when given an idea', () => {
    const seed = buildLiveAppSeed('A dashboard of open PRs for hybridclaw');
    expect(stripAppBuildDirective(seed)).toContain(
      'A dashboard of open PRs for hybridclaw',
    );
    expect(seed).toMatch(/connected MCP servers \/ tools are the data source/i);
    expect(seed).toMatch(/do not ask me which data source/i);
    expect(seed).not.toMatch(/suggest a few useful live apps/i);
    expect(seed).toMatch(/embeds the latest data/i);
  });

  it('suggests options when no idea is given', () => {
    const seed = buildLiveAppSeed('');
    expect(seed).toMatch(/suggest a few useful live apps/i);
    expect(seed).toMatch(/data source/i);
  });
});
