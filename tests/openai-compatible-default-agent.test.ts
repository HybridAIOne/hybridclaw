import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveDefaultAgentId = vi.fn(() => 'main');

vi.mock('../src/config/runtime-config.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/config/runtime-config.js')>();
  return {
    ...actual,
    resolveDefaultAgentId: (...args: unknown[]) =>
      resolveDefaultAgentId(...(args as [])),
  };
});

const { resolveOpenAICompatibleAgentId } = await import(
  '../src/gateway/openai-compatible.js'
);

describe('resolveOpenAICompatibleAgentId', () => {
  beforeEach(() => {
    resolveDefaultAgentId.mockReset();
    resolveDefaultAgentId.mockReturnValue('main');
  });

  it('uses the gateway default agent when the request selects none', () => {
    resolveDefaultAgentId.mockReturnValue('docmoritz-hc');

    expect(resolveOpenAICompatibleAgentId({})).toBe('docmoritz-hc');
  });

  it('keeps an explicitly profiled agent', () => {
    resolveDefaultAgentId.mockReturnValue('docmoritz-hc');

    expect(
      resolveOpenAICompatibleAgentId({ profileAgentId: 'support-desk' }),
    ).toBe('support-desk');
  });

  it('prefers a fresh eval workspace over both', () => {
    resolveDefaultAgentId.mockReturnValue('docmoritz-hc');

    expect(
      resolveOpenAICompatibleAgentId({
        freshAgentId: 'eval-0123456789abcdef',
        profileAgentId: 'support-desk',
      }),
    ).toBe('eval-0123456789abcdef');
  });

  it('falls back to main when no default agent is configured', () => {
    resolveDefaultAgentId.mockReturnValue('');

    expect(resolveOpenAICompatibleAgentId({})).toBe('main');
  });

  it('ignores blank selections', () => {
    resolveDefaultAgentId.mockReturnValue('docmoritz-hc');

    expect(
      resolveOpenAICompatibleAgentId({ freshAgentId: '  ', profileAgentId: '' }),
    ).toBe('docmoritz-hc');
  });
});
