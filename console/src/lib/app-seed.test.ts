import { describe, expect, it } from 'vitest';
import { buildAppSeed, buildLiveAppSeed } from './app-seed';

describe('buildAppSeed', () => {
  it('refines a provided idea (no alternative suggestions) and defaults to React', () => {
    const seed = buildAppSeed('productivity tool', 'A churn dashboard');
    expect(seed).toContain('productivity tool');
    expect(seed).toContain('A churn dashboard');
    expect(seed).toMatch(/refine this briefing/i);
    expect(seed).toMatch(/don't suggest a different app/i);
    expect(seed).toMatch(/propose a short plan/i);
    expect(seed).toMatch(/self-contained/i);
    expect(seed).toMatch(/default to react/i);
  });

  it('asks what to build when no idea is given', () => {
    const seed = buildAppSeed(null, '');
    expect(seed).toMatch(/web app/i);
    expect(seed).toMatch(/ask me/i);
    expect(seed).toMatch(/propose a short plan/i);
  });
});

describe('buildLiveAppSeed', () => {
  it('with an idea: confirms connectors, refines, and does not suggest alternatives', () => {
    const seed = buildLiveAppSeed('A dashboard of open PRs for hybridclaw');
    expect(seed).toContain('A dashboard of open PRs for hybridclaw');
    expect(seed).toMatch(/connectors \/ MCP servers/i);
    expect(seed).toMatch(/confirm the ones this app needs/i);
    expect(seed).toMatch(/don't suggest a different app/i);
    expect(seed).not.toMatch(/suggest a few useful live apps/i);
    expect(seed).toMatch(/embeds the latest data/i);
    expect(seed).toMatch(/refresh/i);
    expect(seed).toMatch(/default to react/i);
  });

  it('without an idea: suggests connector-powered options', () => {
    const seed = buildLiveAppSeed('');
    expect(seed).toMatch(/suggest a few useful live apps/i);
    expect(seed).toMatch(/embeds the latest data/i);
  });
});
