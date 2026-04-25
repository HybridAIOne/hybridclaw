import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseConfidentialYaml } from '../src/security/confidential-rules.js';
import {
  createConfidentialRuntimeContext,
  resetConfidentialRuleSetCache,
  setConfidentialRuleSetForTesting,
} from '../src/security/confidential-runtime.js';

const RULES = parseConfidentialYaml(
  `clients:\n  - name: Serviceplan\n    sensitivity: high\n`,
);

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfidentialRuleSetCache();
});

describe('confidential runtime context', () => {
  test('returns no-op context when no rules exist', () => {
    setConfidentialRuleSetForTesting({ rules: [], sourcePath: null });
    const ctx = createConfidentialRuntimeContext();
    expect(ctx.enabled).toBe(false);
    const messages = [{ role: 'user', content: 'hello Serviceplan' }];
    expect(ctx.dehydrate(messages)).toEqual(messages);
    expect(ctx.rehydrate('hello «CONF:CLIENT_001»')).toBe(
      'hello «CONF:CLIENT_001»',
    );
  });

  test('dehydrates and rehydrates round-trip when rules are present', () => {
    setConfidentialRuleSetForTesting(RULES);

    const ctx = createConfidentialRuntimeContext();
    expect(ctx.enabled).toBe(true);

    const messages = [
      { role: 'system', content: 'You are an assistant.' },
      { role: 'user', content: 'Briefing for Serviceplan today.' },
    ];
    const dehydrated = ctx.dehydrate(messages);
    expect(dehydrated[1].content).not.toContain('Serviceplan');
    expect(typeof dehydrated[1].content).toBe('string');
    expect(ctx.rehydrate(dehydrated[1].content as string)).toContain(
      'Serviceplan',
    );
  });

  test('honours HYBRIDCLAW_CONFIDENTIAL_DISABLE override', () => {
    setConfidentialRuleSetForTesting(RULES);
    vi.stubEnv('HYBRIDCLAW_CONFIDENTIAL_DISABLE', '1');
    const ctx = createConfidentialRuntimeContext();
    expect(ctx.enabled).toBe(false);
  });

  test('wrapDelta rehydrates streamed text', () => {
    setConfidentialRuleSetForTesting(RULES);
    const ctx = createConfidentialRuntimeContext();
    ctx.dehydrate([{ role: 'user', content: 'About Serviceplan' }]);

    const seen: string[] = [];
    const wrapped = ctx.wrapDelta((delta: string) => seen.push(delta));
    wrapped?.('Replying about «CONF:CLIENT_001»');
    expect(seen[0]).toBe('Replying about Serviceplan');
  });

  test('rehydrateFields restores listed string fields and leaves others alone', () => {
    setConfidentialRuleSetForTesting(RULES);
    const ctx = createConfidentialRuntimeContext();
    ctx.dehydrate([{ role: 'user', content: 'About Serviceplan' }]);

    const execution = {
      name: 'noop',
      arguments: 'See «CONF:CLIENT_001»',
      result: 'Reply: «CONF:CLIENT_001»',
      durationMs: 4,
    };
    const next = ctx.rehydrateFields(execution, [
      'arguments',
      'result',
    ] as const);
    expect(next?.arguments).toBe('See Serviceplan');
    expect(next?.result).toBe('Reply: Serviceplan');
    expect(next?.durationMs).toBe(4);
  });

  test('wrapEvent rehydrates listed string fields on each event', () => {
    setConfidentialRuleSetForTesting(RULES);
    const ctx = createConfidentialRuntimeContext();
    ctx.dehydrate([{ role: 'user', content: 'About Serviceplan' }]);

    const seen: { preview?: string }[] = [];
    const wrapped = ctx.wrapEvent(
      (event: { preview?: string }) => seen.push(event),
      ['preview'] as const,
    );
    wrapped?.({ preview: 'tool starting on «CONF:CLIENT_001»' });
    expect(seen[0]?.preview).toBe('tool starting on Serviceplan');
  });
});
