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

  test('dehydrates assistant tool_calls[].function.arguments JSON', () => {
    setConfidentialRuleSetForTesting(RULES);
    const ctx = createConfidentialRuntimeContext();
    const messages = [
      { role: 'user', content: 'search Serviceplan' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'web_search',
              arguments: JSON.stringify({ query: 'Serviceplan' }),
            },
          },
        ],
      },
    ];
    const dehydrated = ctx.dehydrate(messages);
    const toolCallArgs = (
      dehydrated[1] as {
        tool_calls: { function: { arguments: string } }[];
      }
    ).tool_calls[0].function.arguments;
    expect(toolCallArgs).not.toContain('Serviceplan');
    // Result is still parseable JSON with the placeholder substituted.
    const parsed = JSON.parse(toolCallArgs);
    expect(parsed.query).toMatch(/^«CONF:/);
    // The user's content was dehydrated to the same placeholder so the
    // model sees a consistent term throughout the conversation history.
    const userContent = (dehydrated[0] as { content: string }).content;
    expect(userContent).toContain(parsed.query);
  });

  test('messages with tool_calls but no confidential matches are passed through', () => {
    setConfidentialRuleSetForTesting(RULES);
    const ctx = createConfidentialRuntimeContext();
    const messages = [
      {
        role: 'assistant',
        content: 'all good',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'noop',
              arguments: '{"q":"hello world"}',
            },
          },
        ],
      },
    ];
    const dehydrated = ctx.dehydrate(messages);
    expect(dehydrated[0]).toBe(messages[0]);
  });

  test('wrapDelta buffers placeholders split across delta boundaries', () => {
    setConfidentialRuleSetForTesting(RULES);
    const ctx = createConfidentialRuntimeContext();
    ctx.dehydrate([{ role: 'user', content: 'About Serviceplan' }]);

    const seen: string[] = [];
    const wrapped = ctx.wrapDelta((delta: string) => seen.push(delta));
    // The placeholder «CONF:CLIENT_001» is split across three chunks.
    wrapped?.('Replying about ');
    wrapped?.('«CONF:CLIENT_');
    wrapped?.('001» now');
    const joined = seen.join('');
    expect(joined).toContain('Replying about Serviceplan');
    // None of the individual chunks emitted a broken half.
    for (const chunk of seen) {
      expect(chunk).not.toMatch(/«CONF:[A-Z0-9_-]*$/);
      expect(chunk).not.toMatch(/^[A-Z0-9_-]*»/);
    }
  });

  test('wrapDelta releases orphan « after lookahead window expires', () => {
    setConfidentialRuleSetForTesting(RULES);
    const ctx = createConfidentialRuntimeContext();
    const seen: string[] = [];
    const wrapped = ctx.wrapDelta((delta: string) => seen.push(delta));
    // 80 chars of plain text after the «, well past the 64-char
    // lookahead, with no closing » — the tail must be flushed so the
    // user does not stall on a legitimate `«` in prose.
    wrapped?.('quote «');
    wrapped?.('a'.repeat(80));
    const joined = seen.join('');
    expect(joined).toContain('«');
    expect(joined.length).toBeGreaterThan(40);
  });
});
