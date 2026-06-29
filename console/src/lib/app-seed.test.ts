import { describe, expect, it } from 'vitest';
import { buildAppSeed, buildLiveAppSeed } from './app-seed';

describe('buildAppSeed', () => {
  it('includes the category and idea, plus a plan-then-build flow', () => {
    const seed = buildAppSeed('productivity tool', 'A churn dashboard');
    expect(seed).toContain('productivity tool');
    expect(seed).toContain('A churn dashboard');
    expect(seed).toMatch(/propose a short plan/i);
    expect(seed).toMatch(/self-contained/i);
    expect(seed).toMatch(/frontend-design skill/i);
  });

  it('works with no category and no idea', () => {
    const seed = buildAppSeed(null, '');
    expect(seed).toMatch(/web app/i);
    expect(seed).toMatch(/propose a short plan/i);
  });
});

describe('buildLiveAppSeed', () => {
  it('inspects connectors, suggests, plans, then builds with embedded data', () => {
    const seed = buildLiveAppSeed('A dashboard of github review requests');
    expect(seed).toContain('A dashboard of github review requests');
    expect(seed).toMatch(/connectors \/ MCP servers/i);
    expect(seed).toMatch(/suggest/i);
    expect(seed).toMatch(/propose a short plan/i);
    expect(seed).toMatch(/embeds the latest data/i);
    expect(seed).toMatch(/refresh/i);
  });
});
